import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RendererStatusSender } from '../../../renderer/src/runtime/agent-status/renderer-status-sender'
import type { RendererStatusPublication } from '../../../shared/agent-status/renderer-status-publication'
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
  const publish = (version: number, title: string, epoch = 'renderer') =>
    runtime.syncWindowGraph(1, {
      rendererGeneration: epoch,
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: epoch,
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
    expect(frames).toEqual([])
    expect(
      runtime.syncRendererAgentStatus(2, {
        type: 'snapshot',
        epoch: 'renderer',
        seq: 1,
        rows: [status]
      })
    ).toEqual({ accepted: false, reason: 'superseded' })
    expect(
      runtime.syncRendererAgentStatus(1, { type: 'snapshot', epoch: 'old', seq: 1, rows: [status] })
    ).toEqual({ accepted: false, reason: 'superseded' })
    runtime.syncRendererAgentStatus(1, {
      type: 'snapshot',
      epoch: 'renderer',
      seq: 1,
      rows: [status]
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(frames.map((frame) => frame.worktree)).toEqual([TEST_WORKTREE_ID])
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
    frames.length = 0
    publish(1, 'Claude', 'replacement')
    await vi.advanceTimersByTimeAsync(100)
    expect(frames).toEqual([])
    runtime.syncRendererAgentStatus(1, {
      type: 'snapshot',
      epoch: 'replacement',
      seq: 1,
      rows: [status]
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(frames).toHaveLength(1)
    expect(frames[0].tabs[0]).toMatchObject({ agentStatus: { prompt: 'Approve the change' } })

    const batches: RendererStatusPublication[] = []
    let settle: (() => void) | undefined
    let current = status
    const sender = new RendererStatusSender(
      'replacement',
      () => current,
      () => [paneKey],
      (batch) => {
        batches.push(batch)
        if (batches.length === 1) {
          return new Promise((resolve) => {
            settle = () => resolve(runtime.syncRendererAgentStatus(1, batch))
          })
        }
        return Promise.resolve(runtime.syncRendererAgentStatus(1, batch))
      },
      { seq: 1 }
    )
    try {
      sender.graphAccepted()
      await vi.advanceTimersByTimeAsync(16)
      const fence = runtime.markRendererReloading(1)!
      settle!()
      await Promise.resolve()
      current = { ...status, row: { ...status.row, prompt: 'While reloading' } }
      sender.changed(new Set([paneKey]))
      expect(runtime.markRendererReloadCancelled(1, fence)).toBe(true)
      await vi.advanceTimersByTimeAsync(300)
      expect(batches[1]).toMatchObject({
        type: 'snapshot',
        rows: [{ row: { prompt: 'While reloading' } }]
      })
      expect(frames.at(-1)!.tabs[0]).toMatchObject({ agentStatus: { prompt: 'While reloading' } })
      current = { ...status, row: { ...status.row, prompt: 'Current turn' } }
      sender.changed(new Set([paneKey]))
      await vi.advanceTimersByTimeAsync(100)
      expect(batches[2].type).toBe('changes')
      expect(frames.at(-1)!.tabs[0]).toMatchObject({ agentStatus: { prompt: 'Current turn' } })
    } finally {
      sender.stop()
    }
  } finally {
    stop()
  }
})
