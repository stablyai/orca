import type { TrackedActivity } from './host-live-activity-record'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'

export async function refreshHostLiveActivityCensus(
  entry: TrackedActivity,
  runtime: Pick<
    OrcaRuntimeService,
    'restoreStructuredAgentSessionTabs' | 'listAllMobileSessionTabsInventory'
  >
): Promise<void> {
  const updates = new Map<string, RuntimeMobileSessionTabsResult>()
  entry.collecting = updates
  try {
    await runtime.restoreStructuredAgentSessionTabs()
    const inventory = await runtime.listAllMobileSessionTabsInventory(
      entry.principal.deviceId,
      AbortSignal.timeout(5000),
      { includeAgentSenders: false }
    )
    entry.frames = new Map(
      inventory.snapshots.map((frame) => [worktreeIdentityKey(frame.worktree), frame])
    )
    for (const [id, frame] of updates) {
      const previous = entry.frames.get(id)
      if (
        !previous ||
        previous.publicationEpoch !== frame.publicationEpoch ||
        previous.snapshotVersion < frame.snapshotVersion
      ) {
        entry.frames.set(id, frame)
      }
    }
    entry.censusAuthoritative = inventory.authoritative === true
    entry.authoritative = entry.censusAuthoritative
  } catch {
    entry.authoritative = false
    entry.censusAuthoritative = false
  } finally {
    entry.collecting = undefined
    entry.censusAt = Date.now()
  }
}
