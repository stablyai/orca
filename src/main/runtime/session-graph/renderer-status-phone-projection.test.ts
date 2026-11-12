import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
await import('../orca-runtime-tests/runtime-test-module-registration.spec')
const { electronMocks } = await import('../orca-runtime-test-mocks/setup.spec')
const { OrcaRuntimeService } = await import('../orca-runtime')
await import('../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../orca-runtime-tests/orca-runtime-test-fixtures.spec')

beforeEach(() => {
  vi.useFakeTimers()
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
})
afterEach(() => vi.useRealTimers())

it('publishes only the affected phone frame with increasing versions and excludes other publishers', async () => {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.attachWindow(1)
  const paneKey = `host-tab:${HEADLESS_LEAF_ID}`
  const frames: RuntimeMobileSessionTabsResult[] = []
  const stop = runtime.onMobileSessionTabsChanged(
    (frame) => frames.push(frame),
    undefined,
    'mobile'
  )
  const publish = (version: number, title: string) =>
    runtime.syncWindowGraph(1, {
      rendererGeneration: 'renderer',
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer',
          snapshotVersion: version,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: [
            {
              type: 'terminal',
              id: `host-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'host-tab',
              leafId: HEADLESS_LEAF_ID,
              ptyId: null,
              title: 'Claude',
              isActive: true,
              statusSuppressionTitle: title
            }
          ]
        }
      ]
    })
  const status = {
    paneKey,
    leafId: HEADLESS_LEAF_ID,
    rendererPtyId: null,
    row: {
      state: 'blocked' as const,
      prompt: 'Approve the change',
      agentType: 'claude',
      paneKey,
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      stateHistory: []
    }
  }
  try {
    publish(1, 'Claude')
    await vi.advanceTimersByTimeAsync(100)
    const before = frames.at(-1)!.snapshotVersion
    frames.length = 0
    expect(
      runtime.syncRendererAgentStatus(2, {
        type: 'snapshot',
        epoch: 'renderer',
        seq: 1,
        rows: [status]
      })
    ).toEqual({ accepted: false })
    expect(
      runtime.syncRendererAgentStatus(1, { type: 'snapshot', epoch: 'old', seq: 1, rows: [status] })
    ).toEqual({ accepted: false })
    runtime.syncRendererAgentStatus(1, {
      type: 'snapshot',
      epoch: 'renderer',
      seq: 1,
      rows: [status]
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(frames.map((frame) => frame.worktree)).toEqual([TEST_WORKTREE_ID])
    expect(frames[0].snapshotVersion).toBeGreaterThan(before)
    expect(frames[0].tabs[0]).toMatchObject({
      agentStatus: { state: 'blocked', prompt: 'Approve the change' }
    })
    expect(frames[0].tabs[0]).not.toHaveProperty('statusSuppressionTitle')
    const statusVersion = frames[0].snapshotVersion
    publish(2, 'claude agents')
    await vi.advanceTimersByTimeAsync(100)
    expect(frames.at(-1)!.tabs[0]).not.toHaveProperty('agentStatus')
    expect(frames.at(-1)!.snapshotVersion).toBeGreaterThan(statusVersion)
    publish(3, 'Claude')
    await vi.advanceTimersByTimeAsync(100)
    expect(frames.at(-1)!.tabs[0]).toMatchObject({ agentStatus: { prompt: 'Approve the change' } })
  } finally {
    stop()
  }
})
