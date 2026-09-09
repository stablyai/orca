import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from './types'
import { shouldHandoffDaemonHistory } from './daemon-history-handoff'
import type { RouteObservation } from './daemon-session-route-authority'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

export class DaemonRouterSessionCustody {
  readonly releasing = new Map<DaemonPtyAdapter, number>()
  readonly releasingIds = new Set<string>()

  constructor(
    private readonly current: DaemonPtyAdapter,
    private readonly ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
    private readonly adapterFor: (id: string) => DaemonPtyAdapter
  ) {}

  // Select the owner inside the queue; a preceding sleep may transfer it to current.
  run<T>(id: string, operation: (observation: RouteObservation) => Promise<T>): Promise<T> {
    return this.ownerResolver.runWithCustody(id, operation)
  }

  shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<DaemonPtyAdapter> {
    return this.run(id, (observation) => this.releaseWithCustody(id, opts, observation))
  }

  private async releaseWithCustody(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number },
    observation: RouteObservation
  ): Promise<DaemonPtyAdapter> {
    const adapter = this.adapterFor(id)
    this.releasing.set(adapter, (this.releasing.get(adapter) ?? 0) + 1)
    this.releasingIds.add(id)
    try {
      await adapter.shutdown(id, opts)
      const migrateHistory =
        shouldHandoffDaemonHistory(opts.keepHistory, adapter, this.current) &&
        (adapter.protocolVersion < CLEAN_DISCONNECT_PROTOCOL_VERSION ||
          (await adapter.canHandoffHistoryTo(this.current, id)))
      if (!this.ownerResolver.authority.isCurrent(id, observation)) {
        return adapter
      }
      if (!opts.keepHistory || migrateHistory) {
        if (migrateHistory) {
          adapter.ackColdRestore(id)
        }
        this.ownerResolver.forgetRoute(id, adapter, observation)
      } else {
        this.ownerResolver.recordRoute(id, adapter, undefined, observation)
      }
    } finally {
      this.releasingIds.delete(id)
      const remaining = this.releasing.get(adapter)! - 1
      if (remaining === 0) {
        this.releasing.delete(adapter)
      } else {
        this.releasing.set(adapter, remaining)
      }
    }
    return adapter
  }
}
