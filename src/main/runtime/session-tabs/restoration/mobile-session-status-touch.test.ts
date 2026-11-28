import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMobileSessionTabsAgentStatusHeartbeat } from '../../session-lifecycle/publication/mobile-session-tabs-agent-status-heartbeat'
import { MobileSessionSnapshotsByWorktree } from '../publication/mobile-session-snapshots-by-worktree'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { touchMobileSessionStatus } from './mobile-session-status-touch'

const WORKTREE = 'repo::/wt'

afterEach(() => {
  vi.useRealTimers()
})

describe('mobile session status touch', () => {
  // A terminal status change nobody reads builds no frame, so it must not stand in for a chat's pending refresh.
  it('keeps a pending heartbeat when the touch is not published', () => {
    vi.useFakeTimers()
    const emitted: string[] = []
    const heartbeat = createMobileSessionTabsAgentStatusHeartbeat(
      () => [],
      (id) => emitted.push(id)
    )
    const snapshots = new MobileSessionSnapshotsByWorktree()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the touch reads only the worktree key.
    const snapshot = {
      worktree: WORKTREE,
      snapshotVersion: 1,
      tabs: []
    } as unknown as RuntimeMobileSessionTabsSnapshot
    snapshots.set(WORKTREE, snapshot)
    const scheduled: string[] = []
    heartbeat.scheduleWorktreeHeartbeat(WORKTREE)

    touchMobileSessionStatus(WORKTREE, false, {
      heartbeat,
      snapshots,
      schedule: (id) => scheduled.push(id)
    })
    vi.runOnlyPendingTimers()

    expect(scheduled).toEqual([])
    expect(emitted).toEqual([WORKTREE])
    heartbeat.dispose()
  })
})
