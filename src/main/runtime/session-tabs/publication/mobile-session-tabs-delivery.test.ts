import { describe, expect, it } from 'vitest'
import { createMobileSessionTabsDelivery } from './mobile-session-tabs-delivery'
import { MobileSessionSnapshotsByWorktree } from './mobile-session-snapshots-by-worktree'
import type { MobileSessionTabSubscription } from '../../construction/mobile-session-tab-subscription'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

const WORKTREE = 'repo::/wt'

function setup() {
  const snapshots = new MobileSessionSnapshotsByWorktree()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery reads only the worktree key.
  const initial = {
    worktree: WORKTREE,
    snapshotVersion: 1,
    tabs: []
  } as unknown as RuntimeMobileSessionTabsSnapshot
  snapshots.set(WORKTREE, initial)
  const delivered: number[] = []
  const subscription: MobileSessionTabSubscription = {
    listener: () => {},
    clientKind: 'runtime',
    scope: 'agent-sessions'
  }
  const deliver = createMobileSessionTabsDelivery({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the queued path calls only these sender members.
    senders: {
      withPreparedPublication: async <T>(consume: () => T) => consume(),
      buildForFramePass: () => () => ({ associations: [], principals: [], attachments: [] }),
      acknowledgeFrame: () => {}
    } as unknown as Parameters<typeof createMobileSessionTabsDelivery>[0]['senders'],
    listeners: () => [subscription],
    subscribed: () => true,
    project: (frame) => frame,
    deliver: (_subscription, _frame, sequence) => delivered.push(sequence),
    source: (worktree) => snapshots.deliverySource(worktree),
    epoch: () => 1,
    releaseHistory: () => {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the frame's worktree is all delivery reads.
  const frame = { worktree: WORKTREE } as RuntimeMobileSessionTabsResult
  return { snapshots, delivered, deliver, frame, initial }
}

describe('mobile session tabs delivery', () => {
  // A status change no listener reads schedules no replacement, so it must not retire the queued frame.
  it('keeps a queued frame across an unpublished version bump', async () => {
    const { snapshots, delivered, deliver, frame, initial } = setup()
    const sent = deliver(frame, 7)
    snapshots.oweUnpublishedVersion(WORKTREE)
    // Another client's read pays the bump before the queued frame is delivered.
    snapshots.payOwedVersion(WORKTREE, () =>
      snapshots.set(WORKTREE, { ...initial, snapshotVersion: 2 })
    )
    await sent
    expect(delivered).toEqual([7])
  })
})
