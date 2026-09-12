import type { SshConnection } from './ssh-connection'
import { Ssh2PortForwardProvider } from './ssh2-port-forward-provider'
import { SystemSshPortForwardProvider } from './system-ssh-port-forward-provider'
import { SshPortForwardAdmission } from './ssh-port-forward-admission'
import { assertPortForwardResourcesAbsent } from './ssh-port-forward-absence'
import {
  SshPortForwardRetirementCohort,
  type ForwardStartReservation
} from './ssh-port-forward-retirement-cohort'
import type { PortForwardEntry } from '../../shared/ssh-types'
import type {
  PortForwardCloseReason,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'

export type { PortForwardEntry }
export type { PortForwardCloseReason }

export type CapturedSshPortForwardCleanup = {
  removeAndWait: () => Promise<void>
  assertRemoved: () => void
}

type SshPortForwardManagerCallbacks = {
  onForwardClosed?: (entry: PortForwardEntry, reason: PortForwardCloseReason) => void
}

export class SshPortForwardManager {
  private forwards = new Map<string, StartedPortForward>()
  private forwardClosures = new WeakMap<StartedPortForward, Promise<void>>()
  private readonly admission = new SshPortForwardAdmission()
  private readonly retirement = new Map<string, SshPortForwardRetirementCohort>()
  private nextId = 1
  private providers: SshPortForwardProvider[]
  private callbacks: SshPortForwardManagerCallbacks

  constructor(
    callbacks: SshPortForwardManagerCallbacks = {},
    providers: SshPortForwardProvider[] = [
      new Ssh2PortForwardProvider(),
      new SystemSshPortForwardProvider()
    ]
  ) {
    this.callbacks = callbacks
    this.providers = providers
  }

  setCallbacks(callbacks: SshPortForwardManagerCallbacks): void {
    this.callbacks = callbacks
  }

  async addForward(
    connectionId: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label?: string
  ): Promise<PortForwardEntry> {
    return this.admission.run(connectionId, () =>
      this.addForwardWithId(
        `pf-${this.nextId++}`,
        connectionId,
        conn,
        localPort,
        remoteHost,
        remotePort,
        label
      )
    )
  }

  private async addForwardWithId(
    id: string,
    connectionId: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label?: string,
    reservation?: ForwardStartReservation
  ): Promise<PortForwardEntry> {
    const cohort = this.retirementFor(connectionId)
    const provider = this.providers.find((candidate) => candidate.canHandle(conn))
    if (!provider) {
      throw new Error('SSH connection is not established')
    }

    let forward: StartedPortForward | null = null
    const start = reservation?.start ?? ((operation) => cohort.start(operation))
    forward = await start(() =>
      provider.start(conn, {
        id,
        connectionId,
        localHost: '127.0.0.1',
        localPort,
        remoteHost,
        remotePort,
        label,
        assertAdmission: () => cohort.assertAdmission(),
        onUnexpectedClose: (entry, reason) => {
          if (reason.kind === 'unexpected-exit') {
            cohort.fail(new Error(reason.detail ?? 'ssh_port_forward_unexpected_close'))
          }
          const active = this.forwards.get(id)
          if (active !== forward) {
            return
          }
          this.forwards.delete(id)
          this.callbacks.onForwardClosed?.(entry, reason)
        }
      })
    )
    this.forwards.set(id, forward)
    return forward.entry
  }

  async updateForward(
    id: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label?: string
  ): Promise<PortForwardEntry> {
    const existing = this.forwards.get(id)
    if (!existing) {
      throw new Error(`Port forward "${id}" not found`)
    }
    return this.admission.run(existing.entry.connectionId, async () => {
      const oldEntry = { ...existing.entry }
      const reservation = this.retirementFor(oldEntry.connectionId).reserveStart()
      try {
        // Why: use the async variant so the OS fully releases the port before
        // we try to rebind. Without this, same-port edits (e.g. label change)
        // fail with EADDRINUSE because server.close() is async.
        await this.removeForwardAsync(id)

        try {
          return await this.addForwardWithId(
            oldEntry.id,
            oldEntry.connectionId,
            conn,
            localPort,
            remoteHost,
            remotePort,
            label,
            reservation
          )
        } catch (err) {
          // Why: use addForwardWithId to preserve the original ID so the
          // renderer's references remain valid after a failed edit.
          try {
            await this.addForwardWithId(
              oldEntry.id,
              oldEntry.connectionId,
              conn,
              oldEntry.localPort,
              oldEntry.remoteHost,
              oldEntry.remotePort,
              oldEntry.label,
              reservation
            )
          } catch {
            // best-effort rollback
          }
          throw err
        }
      } finally {
        reservation.release()
      }
    })
  }

  fenceForwardAdmission(connectionId: string) {
    const publication = this.admission.fence(connectionId)
    const cohort = this.retirementFor(connectionId)
    const work = cohort.fenceForDrain()
    return {
      assertClosed: publication.assertClosed,
      drain: async (signal = new AbortController().signal) => {
        await publication.drain(signal)
        await work.drain(signal)
        publication.assertDrained()
        work.assertDrained()
      },
      assertDrained: () => {
        publication.assertDrained()
        work.assertDrained()
      },
      assertResetRetirementSupported: () => {
        publication.assertDrained()
        work.assertDrained()
        cohort.assertResetRetirementSupported()
      },
      reconcileResetRetirement: (
        request: Parameters<SshPortForwardRetirementCohort['reconcileResetRetirement']>[0]
      ) => {
        publication.assertDrained()
        work.assertDrained()
        cohort.reconcileResetRetirement(request)
      },
      release: (assertAuthorized: () => void) => {
        const released = publication.release(() => {
          assertAuthorized()
          cohort.assertReconciled()
        })
        this.retirement.delete(connectionId)
        return {
          assertReleased: () => {
            released.assertReleased()
            if (this.retirement.has(connectionId)) {
              throw new Error('ssh_port_forward_released_cohort_changed')
            }
          }
        }
      }
    }
  }

  private retirementFor(connectionId: string): SshPortForwardRetirementCohort {
    let cohort = this.retirement.get(connectionId)
    if (!cohort) {
      cohort = new SshPortForwardRetirementCohort()
      this.retirement.set(connectionId, cohort)
    }
    return cohort
  }

  assertTargetResourcesAbsent(connectionId: string): void {
    assertPortForwardResourcesAbsent(
      connectionId,
      this.admission,
      this.retirement.get(connectionId),
      () => this.listForwards(connectionId).length > 0
    )
  }


  removeForward(id: string): PortForwardEntry | null {
    const forward = this.forwards.get(id)
    if (!forward) {
      return null
    }
    forward.dispose()
    this.forwards.delete(id)
    return forward.entry
  }

  async removeForwardAndWait(id: string): Promise<PortForwardEntry | null> {
    return this.removeForwardAsync(id)
  }

  // Why: server.close()/process exit are async — callers that need to rebind
  // the same port (update/reconnect) must wait until the owner fully releases it.
  private removeForwardAsync(id: string): Promise<PortForwardEntry | null> {
    const forward = this.forwards.get(id)
    if (!forward) {
      return Promise.resolve(null)
    }
    this.forwards.delete(id)
    return this.closeForward(forward).then(() => forward.entry)
  }

  private closeForward(forward: StartedPortForward): Promise<void> {
    let completion = this.forwardClosures.get(forward)
    if (!completion) {
      completion = Promise.resolve()
        .then(() => forward.close())
        .then(() => {
          this.retirementFor(forward.entry.connectionId).pruneRetired()
        })
      this.forwardClosures.set(forward, completion)
      void completion.catch((error: unknown) => {
        this.retirementFor(forward.entry.connectionId).fail(
          error instanceof Error ? error : new Error(String(error))
        )
        if (this.forwardClosures.get(forward) === completion) {
          this.forwardClosures.delete(forward)
        }
      })
    }
    return completion
  }

  /** Captures local listener instances, not remote process-exit evidence. */
  captureForwardCleanup(connectionId: string): CapturedSshPortForwardCleanup {
    const selected = [...this.forwards.entries()].filter(
      ([, forward]) => forward.entry.connectionId === connectionId
    )
    let removed = false
    const assertRemoved = () => {
      if (!removed || selected.some(([id, forward]) => this.forwards.get(id) === forward)) {
        throw new Error('ssh_port_forward_cleanup_unconfirmed')
      }
    }
    return {
      removeAndWait: async () => {
        for (const [id, forward] of selected) {
          if (this.forwards.get(id) === forward) {
            this.forwards.delete(id)
          }
        }
        await Promise.all(selected.map(([, forward]) => this.closeForward(forward)))
        removed = true
        assertRemoved()
      },
      assertRemoved
    }
  }

  listForwards(connectionId?: string): PortForwardEntry[] {
    return Array.from(this.forwards.values(), ({ entry }) => entry).filter(
      (entry) => !connectionId || entry.connectionId === connectionId
    )
  }

  async removeAllForwards(connectionId: string): Promise<void> {
    const toRemove = [...this.forwards.entries()]
      .filter(([, { entry }]) => entry.connectionId === connectionId)
      .map(([id]) => id)
    await Promise.all(toRemove.map((id) => this.removeForwardAsync(id)))
  }

  dispose(): void {
    const ids = [...this.forwards.keys()]
    for (const id of ids) {
      this.removeForward(id)
    }
  }
}
