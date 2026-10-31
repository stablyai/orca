import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { MIRROR_LEAVES_STEP_1 } from './runtime-leaf-record-projection.test-fixture'
import { makeTuiIdlePty } from './tui-idle-wait-test-harness'

const PTY_ID = 'pty-local-1'
const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-terminal'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

it('keeps a running terminal’s sender row, by its start-time handle, while no window graph exists', () => {
  const runtime = new OrcaRuntimeService(null)
  runtime.setPtyController({
    write: () => true,
    kill: vi.fn(() => true),
    getForegroundProcess: async () => null
  })
  // The handle the terminal's agent is started with, which its mail cards save as the sender.
  const handle = runtime.preAllocateHandleForPty(PTY_ID)
  runtime.registerPty(PTY_ID, WORKTREE_ID, 'target', {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: 'inc-1'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: PTY_ID }
    ]
  })
  const { senders } = runtime['agentProjections']
  const row = { identity: handle, paneKey: `${TAB_ID}:${LEAF_ID}`, worktreeId: WORKTREE_ID }
  expect(senders.build().associations).toContainEqual(row)

  // The window closes: the host drops its leaves and handle records, and keeps start-time handles.
  runtime.markGraphUnavailable(1)
  const records = new Map(runtime['handles'])
  expect(senders.build().associations).toContainEqual(row)
  // Reading the handle issued nothing.
  expect(runtime['handles']).toEqual(records)
})

it.each([100, 1000])(
  'reads every leafless terminal’s handle with one pass over the handle records, at %i terminals',
  (n) => {
    const runtime = new OrcaRuntimeService(null)
    // n terminals the window shows, each holding a handle record.
    for (let i = 0; i < n; i++) {
      const leaf = {
        ...MIRROR_LEAVES_STEP_1[0],
        tabId: `tab-${i}`,
        leafId: LEAF_ID,
        worktreeId: WORKTREE_ID,
        ptyId: `leaf-pty-${i}`
      }
      runtime['leaves'].set(runtime['getLeafKey'](leaf.tabId, LEAF_ID), leaf)
      runtime['issueHandle'](leaf)
    }
    // A leafless terminal whose handle survives only as its record, as invalidating its other
    // aliases leaves it, and n leafless terminals that hold no handle.
    const kept = makeTuiIdlePty({ ptyId: 'kept', incarnationId: 'inc-1', worktreeId: WORKTREE_ID })
    const keptHandle = runtime['issuePtyHandle'](kept)
    runtime['handleByPtyId'].delete('kept')
    const unissued = Array.from({ length: n }, (_, i) =>
      makeTuiIdlePty({ ptyId: `bare-${i}`, incarnationId: 'inc-1', worktreeId: WORKTREE_ID })
    )
    const passes = vi.spyOn(runtime['handles'], Symbol.iterator)
    const read = runtime['peekPtyHandles']()
    expect(read(kept)).toBe(keptHandle)
    expect(unissued.map(read).filter((handle) => handle !== null)).toEqual([])
    expect(passes).toHaveBeenCalledTimes(1)
    // The same handle issuing would reuse.
    expect(runtime['findHandleForPtyRecord']('kept')).toBe(keptHandle)
  }
)
