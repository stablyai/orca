import {
  nextWorkspaceSnapshotPruneSequence,
  registerWorkspaceSnapshotPrunesForFile,
  WORKSPACE_SNAPSHOT_PRUNE_PRODUCER_TIMEOUT_MS,
  type WorkspaceSnapshotPruneTarget,
  type WorkspaceSnapshotPruneTombstone
} from './workspace-snapshot-prune-index'

/** Held by a deferred removal batch between its tombstone write and its sidecar flush. */
export const WORKSPACE_SNAPSHOT_PRUNE_FLUSH_HOLDER = 'flush'

/**
 * Write capability for one sidecar, minted only by `withProducer`. `persist*` takes it as a
 * required parameter, so a future persist call site cannot compile without opening the fence.
 */
export type WorkspaceSnapshotPruneProducerToken = {
  /** Where this producer sits in the prune order: tombstones registered after it fence its result. */
  readonly seq: number
  /**
   * Claim the capability for `file` and get its release. Null once the producer was bounded out, or
   * when the token was minted for a different sidecar — a disarmed producer must never write.
   */
  readonly beginWrite: (file: string) => (() => void) | null
}

/**
 * Owns tombstone lifetime for one sidecar file (STA-4451). A tombstone only has to outlive the
 * writers that could still put the removed row back, so it is retired when the last of them
 * releases it — never on a clock reading.
 */
export type WorkspaceSnapshotPruneTombstoneRegistry = {
  /** Live tombstones for this sidecar. */
  tombstones: (file: string) => Map<string, WorkspaceSnapshotPruneTombstone> | undefined
  /** `deferred` marks a batch that tombstones now and rewrites the sidecar at finalize. */
  register: (
    file: string,
    targets: readonly WorkspaceSnapshotPruneTarget[],
    deferred: boolean
  ) => void
  /**
   * Run `produce` inside the fence. Its tombstones are held from before it starts until it can no
   * longer write, and the returned promise settles with `produce` — a write it left in flight keeps
   * the fence open without delaying the caller.
   */
  withProducer: <T>(
    snapshotDirectory: string,
    produce: (producer: WorkspaceSnapshotPruneProducerToken) => Promise<T>
  ) => Promise<T>
  releaseFlush: (file: string, keys: ReadonlySet<string>) => void
  count: (file: string) => number
}

export function createWorkspaceSnapshotPruneTombstoneRegistry(
  resolveFile: (snapshotDirectory: string) => string
): WorkspaceSnapshotPruneTombstoneRegistry {
  const tombstonesByFile = new Map<string, Map<string, WorkspaceSnapshotPruneTombstone>>()
  const activeProducersByFile = new Map<string, Set<string>>()
  let nextProducerId = 0

  const release = (file: string, holder: string, keys?: ReadonlySet<string>): void => {
    const tombstones = tombstonesByFile.get(file)
    for (const [key, entry] of tombstones ?? []) {
      // Guard on membership: releasing one holder must not retire tombstones held by others.
      if ((!keys || keys.has(key)) && entry.holders.delete(holder) && entry.holders.size === 0) {
        tombstones?.delete(key)
      }
    }
    if (tombstones?.size === 0) {
      tombstonesByFile.delete(file)
    }
  }

  const live = (file: string): Map<string, WorkspaceSnapshotPruneTombstone> | undefined =>
    tombstonesByFile.get(file)

  return {
    tombstones: live,
    register(file, targets, deferred) {
      const tombstones = live(file) ?? new Map()
      registerWorkspaceSnapshotPrunesForFile(tombstones, targets, [
        ...(deferred ? [WORKSPACE_SNAPSHOT_PRUNE_FLUSH_HOLDER] : []),
        ...(activeProducersByFile.get(file) ?? [])
      ])
      if (tombstones.size > 0) {
        tombstonesByFile.set(file, tombstones)
      } else {
        tombstonesByFile.delete(file)
      }
    },
    async withProducer(snapshotDirectory, produce) {
      const file = resolveFile(snapshotDirectory)
      const holder = `producer:${(nextProducerId += 1)}`
      const active = activeProducersByFile.get(file) ?? new Set<string>()
      active.add(holder)
      activeProducersByFile.set(file, active)

      let writes = 0
      let closed = false
      let disarmed = false
      const settle = (): void => {
        // A producer with a write in flight is demonstrably alive, so the bound waits it out: the
        // holder is only ever dropped while the producer holds no capability to use it.
        if (disarmed || !closed || writes > 0) {
          return
        }
        disarmed = true
        clearTimeout(bound)
        const holders = activeProducersByFile.get(file)
        if (holders?.delete(holder) && holders.size === 0) {
          activeProducersByFile.delete(file)
        }
        release(file, holder)
      }
      // setTimeout runs on the runtime's monotonic clock, so a lid-close cannot expire a live scan.
      const bound = setTimeout(() => {
        closed = true
        settle()
      }, WORKSPACE_SNAPSHOT_PRUNE_PRODUCER_TIMEOUT_MS)
      bound.unref?.()

      const producer: WorkspaceSnapshotPruneProducerToken = {
        seq: nextWorkspaceSnapshotPruneSequence(),
        beginWrite: (target) => {
          if (closed || target !== file) {
            return null
          }
          writes += 1
          let released = false
          return () => {
            if (released) {
              return
            }
            released = true
            writes -= 1
            settle()
          }
        }
      }

      try {
        return await produce(producer)
      } finally {
        closed = true
        settle()
      }
    },
    releaseFlush: (file, keys) => release(file, WORKSPACE_SNAPSHOT_PRUNE_FLUSH_HOLDER, keys),
    count: (file) => live(file)?.size ?? 0
  }
}

export { WORKSPACE_SNAPSHOT_PRUNE_PRODUCER_TIMEOUT_MS }
