import type { RuntimeHostStatusSnapshot } from '../../shared/remote-runtime/host-status/runtime-host-status'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import { subscribeRemoteRuntimeTransport } from '../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import {
  getRuntimeEnvironmentStatusSnapshot,
  getRuntimeEnvironmentStatusSnapshots
} from '../ipc/runtime-environments/connections/runtime-environment-request-connections'
import {
  getRuntimeEnvironmentTransportGeneration,
  onRuntimeEnvironmentTransportGenerationRetired
} from '../ipc/runtime-environments/connections/runtime-environment-transport-generation'
import { onRuntimeEnvironmentStatusPublished } from '../ipc/runtime-environments/status/runtime-environment-status-owner'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environments/connectivity/runtime-environment-manual-disconnect'
import {
  createPassiveSessionStreamOpener,
  type PassiveSessionStreamOpener
} from '../ipc/runtime-environments/subscriptions/runtime-environment-passive-session-stream'
import {
  isNotchSessionRecord,
  notchRemoteSessionRows,
  type NotchRemoteObservation
} from './notch-remote-session-frame'

export type { NotchRemoteObservation } from './notch-remote-session-frame'

function ready(snapshot: RuntimeHostStatusSnapshot | null): boolean {
  return Boolean(
    snapshot &&
    !snapshot.retired &&
    snapshot.verification === 'verified' &&
    snapshot.transport === 'ready' &&
    snapshot.status &&
    !isRuntimeEnvironmentManuallyDisconnected(snapshot.environmentId)
  )
}

const openPassiveStream = createPassiveSessionStreamOpener({
  resolve: async (environmentId) => {
    const snapshot = getRuntimeEnvironmentStatusSnapshot(environmentId)
    if (!snapshot || !ready(snapshot)) {
      return null
    }
    const generation = getRuntimeEnvironmentTransportGeneration(environmentId)
    const environment = await resolveEnvironment(getRuntimeEnvironmentRegistryRoot(), environmentId)
    const current = getRuntimeEnvironmentStatusSnapshot(environmentId)
    return current &&
      ready(current) &&
      current.pairingRevision === snapshot.pairingRevision &&
      current.status?.runtimeId === snapshot.status?.runtimeId &&
      (environment.pairingRevision ?? environment.createdAt) === current.pairingRevision &&
      environment.runtimeId === current.status?.runtimeId &&
      generation === getRuntimeEnvironmentTransportGeneration(environmentId)
      ? getPreferredPairedRuntimeConnection(environment)
      : null
  },
  subscribe: subscribeRemoteRuntimeTransport,
  isManuallyDisconnected: isRuntimeEnvironmentManuallyDisconnected
})

type HostWatch = {
  owner: string
  identity: string
  stream: { close: () => void } | null
  retry: ReturnType<typeof setTimeout> | null
  attempt: number
  rows: Map<string, NotchRemoteObservation[]>
  receipts: Map<string, NotchRemoteObservation>
  generation: number
}

/** Main owns these passive observations even while the application renderer is closed. */
export class NotchRemoteSessions {
  private started = false
  private readonly watches = new Map<string, HostWatch>()
  private readonly listeners = new Set<() => void>()
  private readonly receipts = new Map<
    string,
    { owner: string; rows: Map<string, NotchRemoteObservation> }
  >()
  private stops: (() => void)[] = []

  constructor(private readonly openStream: PassiveSessionStreamOpener = openPassiveStream) {}

  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    this.stops = [
      onRuntimeEnvironmentStatusPublished((snapshot) => this.reconcile(snapshot)),
      onRuntimeEnvironmentTransportGenerationRetired((environmentId) => this.retire(environmentId))
    ]
    for (const snapshot of getRuntimeEnvironmentStatusSnapshots()) {
      this.reconcile(snapshot)
    }
  }

  stop(): void {
    this.started = false
    for (const stop of this.stops.splice(0)) {
      stop()
    }
    for (const id of this.watches.keys()) {
      this.retire(id)
    }
  }

  getRows(): readonly NotchRemoteObservation[] {
    return [...this.watches.values()].flatMap((watch) => [...watch.rows.values()].flat())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private reconcile(snapshot: RuntimeHostStatusSnapshot): void {
    if (!this.started) {
      return
    }
    const id = snapshot.environmentId
    if (!ready(snapshot)) {
      this.retire(id)
      if (snapshot.retired || snapshot.verification === 'blocked') {
        this.receipts.delete(id)
      }
      return
    }
    const identity = `${snapshot.pairingRevision}\0${snapshot.status?.runtimeId}\0${getRuntimeEnvironmentTransportGeneration(id)}`
    if (this.watches.get(id)?.identity === identity) {
      return
    }
    this.retire(id)
    const owner = `${snapshot.pairingRevision}\0${snapshot.status?.runtimeId}`
    const saved = this.receipts.get(id)
    const watch: HostWatch = {
      owner,
      identity,
      stream: null,
      retry: null,
      attempt: 0,
      rows: new Map(),
      receipts: saved?.owner === owner ? saved.rows : new Map(),
      generation: 0
    }
    this.watches.set(id, watch)
    this.receipts.set(id, { owner, rows: watch.receipts })
    this.open(id, watch)
  }

  private retire(id: string): void {
    const watch = this.watches.get(id)
    if (!watch) {
      return
    }
    this.watches.delete(id)
    if (watch.retry) {
      clearTimeout(watch.retry)
    }
    watch.stream?.close()
    if (watch.rows.size) {
      this.publish()
    }
  }

  private open(id: string, watch: HostWatch): void {
    const generation = ++watch.generation
    let ended = false
    const isCurrent = (): boolean =>
      !ended && this.started && this.watches.get(id) === watch && generation === watch.generation
    const end = (): void => {
      if (!isCurrent()) {
        return
      }
      ended = true
      watch.stream?.close()
      watch.stream = null
      watch.rows.clear()
      this.publish()
      const delay = Math.min(30_000 * 2 ** Math.min(watch.attempt++, 4), 300_000)
      watch.retry = setTimeout(() => {
        watch.retry = null
        if (this.watches.get(id) === watch && ready(getRuntimeEnvironmentStatusSnapshot(id))) {
          this.open(id, watch)
        }
      }, delay)
      watch.retry.unref?.()
    }
    void this.openStream(id, {
      onFrame: (frame) => {
        if (!isCurrent() || !isNotchSessionRecord(frame)) {
          return
        }
        if (!ready(getRuntimeEnvironmentStatusSnapshot(id))) {
          end()
          return
        }
        if (frame.type === 'end') {
          end()
          return
        }
        const snapshots =
          frame.type === 'snapshots' && Array.isArray(frame.snapshots)
            ? frame.snapshots
            : frame.type === 'snapshot' || frame.type === 'updated'
              ? [frame]
              : null
        if (!snapshots) {
          return
        }
        if (frame.type === 'snapshots') {
          watch.rows.clear()
        }
        const now = Date.now()
        for (const snapshot of snapshots) {
          if (!isNotchSessionRecord(snapshot) || typeof snapshot.worktree !== 'string') {
            continue
          }
          if (snapshot.removed === true) {
            watch.rows.delete(snapshot.worktree)
          } else {
            watch.rows.set(
              snapshot.worktree,
              notchRemoteSessionRows(id, snapshot, watch.receipts, now, watch.owner)
            )
          }
        }
        watch.receipts = new Map(
          [...watch.rows.values()].flatMap((rows) => rows.map((row) => [row.paneKey, row] as const))
        )
        const saved = this.receipts.get(id)
        if (saved) {
          saved.rows = watch.receipts
        }
        watch.attempt = 0
        this.publish()
      },
      onEnd: end
    }).then((stream) => {
      if (stream === 'unsupported') {
        end()
      } else if (isCurrent()) {
        watch.stream = stream
      } else {
        stream.close()
      }
    }, end)
  }
}
