import {
  TerminalHistoryProfile,
  ownsTerminalHistoryWriter,
  drainRetiredTerminalHistoryManagers,
  type HistoryParticipant,
  type TerminalReservationParticipant,
  type TerminalHistoryMigrationLease
} from './terminal-history-root-registry'
export { terminalHistoryRoot } from './terminal-history-root-registry'
export type {
  TerminalReservationParticipant,
  TerminalHistoryMigrationLease
} from './terminal-history-root-registry'
import { collectTerminalHistoryReservations } from './terminal-history-reservation-census'
import { TerminalHistoryWriterHandoff } from './terminal-history-writer-handoff'
import type { TerminalHistorySessionWriter } from './terminal-history-session-writer'

type HeldMigration = TerminalHistoryMigrationLease & {
  epoch: number
  freezing: boolean
  ids: readonly string[]
  releases: (() => void)[]
}

const checkpointReceipt = Symbol('terminalHistoryCheckpointReceipt')
export type TerminalHistoryCheckpointReceipt = { readonly [checkpointReceipt]: true }
type ObservedWork = {
  epoch: number
  checkpoint: boolean
  completion: Promise<unknown>
}

/** One authority covers adapters and history managers sharing the same physical directory. */
export class TerminalHistoryRoot {
  private readonly profile = new TerminalHistoryProfile()
  private readonly writerHandoff = new TerminalHistoryWriterHandoff()
  private readonly unpublishedTargets = new Map<string, object>()
  private epoch = 0
  private admissionEpoch = 0
  private census: { epoch: number; result: Promise<ReadonlySet<string> | null> } | null = null
  private readonly hosts = new Set<TerminalReservationParticipant>()
  private readonly managers = new Set<HistoryParticipant>()
  private readonly work = new Map<string, Map<TerminalHistoryCheckpointReceipt, ObservedWork>>()
  private readonly holds = new Map<string, HeldMigration>()
  private readonly raw = new Map<string, Set<object>>()
  private readonly creations = new Set<string>()

  constructor(readonly path: string) {}

  profileReady = () => this.profile.ready()

  bindProfile(
    profileRoot: string,
    runtimeDir: string,
    localReservations: () => Iterable<string>
  ): Promise<void> {
    if (this.profile.bind(profileRoot, runtimeDir, localReservations)) {
      this.invalidate()
    }
    return this.profile.ready()
  }

  matchesProfile = this.profile.matches.bind(this.profile)

  retainUnpublishedTarget(id: string): { current: () => boolean; release: () => void } {
    const token = {}
    const epoch = this.epoch
    this.unpublishedTargets.set(id, token)
    return {
      current: () =>
        this.epoch === epoch && this.profile.owned() && this.unpublishedTargets.get(id) === token,
      release: () => {
        if (this.unpublishedTargets.get(id) === token) {
          this.unpublishedTargets.delete(id)
        }
      }
    }
  }

  invalidate(): void {
    this.epoch += 1
    this.creations.clear()
    for (const hold of this.holds.values()) {
      hold.release()
    }
  }

  registerHost(host: TerminalReservationParticipant): () => void {
    this.invalidate()
    this.hosts.add(host)
    return () => {
      this.invalidate()
      this.hosts.delete(host)
    }
  }

  registerManager(manager: HistoryParticipant): () => void {
    this.managers.add(manager)
    for (const hold of new Set(this.holds.values())) {
      if (hold.freezing) {
        try {
          for (const id of hold.ids) {
            this.writerHandoff.revoke(id)
            hold.releases.push(manager.freeze(id))
          }
        } catch {
          hold.release()
        }
      }
    }
    return () => {
      this.cancelMigrations()
      this.managers.delete(manager)
    }
  }

  cancelMigrations(): void {
    for (const hold of this.holds.values()) {
      hold.release()
    }
  }

  drainRetired = (id: string, except: HistoryParticipant): Promise<unknown[]> | undefined =>
    drainRetiredTerminalHistoryManagers(this.managers, id, except)

  captureWriter(
    id: string,
    writer: TerminalHistorySessionWriter,
    persistenceReady: Promise<unknown>
  ) {
    return this.writerHandoff.capture(
      id,
      !this.holds.get(id)?.freezing && ownsTerminalHistoryWriter(this.managers, id, writer),
      persistenceReady
    )
  }

  admitWriter(id: string) {
    this.willMutate(id)
    return this.writerHandoff.admit(id)
  }

  willMutate(id: string, receipt?: TerminalHistoryCheckpointReceipt): void {
    this.unpublishedTargets.delete(id)
    const hold = this.holds.get(id)
    const admitted = receipt && this.work.get(id)?.get(receipt)
    if (hold && !(admitted?.checkpoint && admitted.epoch < hold.epoch && !hold.freezing)) {
      hold.release()
    }
  }

  observeWork<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.recordWork(id, false, operation)
  }

  checkpointWork<T>(
    id: string,
    operation: (receipt: TerminalHistoryCheckpointReceipt) => Promise<T>
  ): Promise<T> {
    return this.recordWork(id, true, operation)
  }

  private recordWork<T>(
    id: string,
    checkpoint: boolean,
    operation: (receipt: TerminalHistoryCheckpointReceipt) => Promise<T>
  ): Promise<T> {
    this.willMutate(id)
    const receipt: TerminalHistoryCheckpointReceipt = { [checkpointReceipt]: true }
    const pending = this.work.get(id) ?? new Map<TerminalHistoryCheckpointReceipt, ObservedWork>()
    this.work.set(id, pending)
    const finish = (): void => {
      pending.delete(receipt)
      if (!pending.size && this.work.get(id) === pending) {
        this.work.delete(id)
      }
    }
    const completion = Promise.resolve()
      .then(() => operation(receipt))
      .then(
        (value) => {
          finish()
          return value
        },
        (error: unknown) => {
          finish()
          throw error
        }
      )
    pending.set(receipt, { epoch: this.admissionEpoch, checkpoint, completion })
    return completion
  }

  observeNumeric(id: string, creating: boolean): (missing: boolean) => void {
    if (!/^\d+$/.test(id)) {
      return () => {}
    }
    this.willMutate(id)
    const token = {}
    const active = this.raw.get(id) ?? new Set<object>()
    active.add(token)
    this.raw.set(id, active)
    if (creating) {
      this.creations.add(id)
    }
    return (missing) => {
      active.delete(token)
      if (!active.size && this.raw.get(id) === active) {
        this.raw.delete(id)
      }
      if (!missing) {
        this.creations.add(id)
      }
    }
  }

  private reservationCensus(): Promise<ReadonlySet<string> | null> {
    if (this.census?.epoch === this.epoch) {
      return this.census.result
    }
    const epoch = this.epoch
    const result = collectTerminalHistoryReservations(
      this.profile,
      [...this.hosts],
      () => epoch === this.epoch
    )
    this.census = { epoch, result }
    return result
  }

  async beginMigration(
    ids: readonly string[],
    eligible: () => boolean
  ): Promise<TerminalHistoryMigrationLease | null> {
    await this.profile.ready()
    if (
      !this.profile.owned() ||
      !eligible() ||
      ids.some((id) => this.holds.has(id) || this.writerHandoff.admitting(id))
    ) {
      return null
    }
    let cancel!: () => void
    const canceled = new Promise<void>((done) => {
      cancel = done
    })
    let active = true
    const epoch = ++this.admissionEpoch
    const authorityEpoch = this.epoch
    const hold: HeldMigration = {
      epoch,
      ids,
      canceled,
      freezing: false,
      releases: [],
      current: () => active && this.epoch === authorityEpoch && this.profile.owned() && eligible(),
      release: () => {
        if (!active) {
          return
        }
        active = false
        for (const release of hold.releases.splice(0).toReversed()) {
          release()
        }
        for (const id of ids) {
          if (this.holds.get(id) === hold) {
            this.holds.delete(id)
          }
        }
        clearTimeout(timer)
        cancel()
      }
    }
    const timer = setTimeout(hold.release, 1_000)
    timer.unref?.()
    for (const id of ids) {
      this.holds.set(id, hold)
    }
    const drain = (async () => {
      const tails = ids.flatMap((id) =>
        [...(this.work.get(id)?.values() ?? [])].map((work) => work.completion)
      )
      await Promise.allSettled(tails)
      await Promise.all(ids.flatMap((id) => [...this.managers].map((m) => m.drain(id))))
      if (!hold.current()) {
        return false
      }
      const reservations = await this.reservationCensus()
      if (
        !hold.current() ||
        !reservations ||
        ids.some((id) => reservations.has(id) || this.raw.has(id) || this.creations.has(id))
      ) {
        return false
      }
      hold.freezing = true
      for (const id of ids) {
        this.writerHandoff.revoke(id)
      }
      for (const manager of this.managers) {
        for (const id of ids) {
          hold.releases.push(manager.freeze(id))
        }
      }
      return hold.current()
    })().catch(() => false)
    const ready = await Promise.race([drain, canceled.then(() => false)])
    if (!ready) {
      hold.release()
      return null
    }
    clearTimeout(timer)
    return hold
  }
}
