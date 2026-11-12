import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { WorktreeTerminalStopSnapshot } from './worktree-terminal-stop-options'
import {
  indexWorktreeRemovalTargets,
  worktreeRemovalTargetKey,
  type WorktreeRemovalTarget
} from '../../workspaces/removal/worktree-removal-targets'
import { worktreePtyBelongsToHost } from '../../workspaces/removal/worktree-pty-host-fence'

/** Hold existing spawn leases while one graph pass assigns candidates to host-fenced folders. */
export async function captureWorktreeTerminalStops(
  targets: readonly WorktreeRemovalTarget[],
  ports: {
    acquire(id: string): Promise<() => void>
    captureFence(): () => void
    leaves(): Iterable<{ worktreeId: string; ptyId: string | null }>
    ptys: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  }
): Promise<{ snapshots: ReadonlyMap<string, WorktreeTerminalStopSnapshot>; finish(): void }> {
  const releases: (() => void)[] = []
  const failedLeases = new Set<string>()
  const finish = (): void => {
    for (const release of releases.toReversed()) {
      release()
    }
  }
  try {
    for (const id of [...new Set(targets.map((target) => target.worktreeId))].sort()) {
      try {
        releases.push(await ports.acquire(id))
      } catch (error) {
        failedLeases.add(id)
        console.warn('[worktree-teardown] mutation lease unavailable:', error)
      }
    }
    const assertGraphCurrent = ports.captureFence()
    const index = indexWorktreeRemovalTargets(targets)
    const snapshots = new Map<string, WorktreeTerminalStopSnapshot>()
    for (const target of targets) {
      snapshots.set(worktreeRemovalTargetKey(target), {
        leaseHeld: !failedLeases.has(target.worktreeId),
        ptyIds: new Set(),
        records: new Map(),
        assertCurrent: (ptyId) => {
          assertGraphCurrent()
          const snapshot = snapshots.get(worktreeRemovalTargetKey(target))!
          if (ptyId && !snapshot.records.has(ptyId)) {
            const current = ports.ptys.get(ptyId)
            if (
              current &&
              (current.worktreeId !== target.worktreeId ||
                (current.connectionId ?? null) !== target.connectionId ||
                current.worktreeInferredFromCwd)
            ) {
              throw new Error('Terminal ownership changed during removal')
            }
          }
          for (const id of ptyId && snapshot.records.has(ptyId) ? [ptyId] : []) {
            const before = snapshot.records.get(id)
            const after = ports.ptys.get(id)
            // Exit may retire a record; replacement or reattribution invalidates the captured stop.
            if (
              after &&
              (before?.incarnationId !== after.incarnationId ||
                before?.worktreeId !== after.worktreeId ||
                before?.connectionId !== after.connectionId ||
                after.worktreeInferredFromCwd)
            ) {
              throw new Error('Terminal ownership changed during removal')
            }
          }
        }
      })
    }
    const add = (worktreeId: string, ptyId: string): void => {
      if (ptyId.startsWith('remote:')) {
        return
      }
      const record = ports.ptys.get(ptyId)
      if (record?.worktreeInferredFromCwd || (record && record.worktreeId !== worktreeId)) {
        return
      }
      const target = index.get(worktreeId)?.get(record?.connectionId ?? null)
      if (
        !target ||
        !worktreePtyBelongsToHost(ptyId, record?.connectionId, {
          resolvedConnectionId: target.connectionId
        })
      ) {
        return
      }
      const snapshot = snapshots.get(worktreeRemovalTargetKey(target))
      if (snapshot) {
        snapshot.ptyIds.add(ptyId)
        snapshot.records.set(ptyId, record ? { ...record } : undefined)
      }
    }
    for (const leaf of ports.leaves()) {
      if (leaf.ptyId) {
        add(leaf.worktreeId, leaf.ptyId)
      }
    }
    for (const record of ports.ptys.values()) {
      if (record.connected) {
        add(record.worktreeId, record.ptyId)
      }
    }
    return { snapshots, finish }
  } catch (error) {
    finish()
    throw error
  }
}
