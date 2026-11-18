import { describe, expect, it, vi } from 'vitest'
import '../../terminal/layout/bind-first-pane.test-fixture'
import { makeAgentStatusStoreWiring } from '../../terminal/identity/agent-status-store-wiring.test-fixture'
import '../../construction/test-context/runtime-test-module-registration.spec'
import '../../../../shared/agent-status/contracts/agent-status-freshness'
import { MOCK_GIT_WORKTREES } from '../../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { listWorktrees } from '../../../git/worktrees/catalog/worktree-scan-cache'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('suppresses restored-unconfirmed hook rows from worktree.ps', async () => {
    const leafId = '33333333-3333-4333-8333-333333333333'
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: `tab-1:${leafId}`,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          prompt: 'may have finished offline',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100,
          restoredUnconfirmed: true
        }
      ]
    })
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: []
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ hasHostSidebarActivity: false, status: 'inactive', agents: [] })
  })

  it('uses mirrored tab ownership after a workspace rename instead of stale hook attribution', async () => {
    const renamedPath = '/tmp/worktree-renamed'
    const renamedWorktreeId = `${TEST_REPO_ID}::${renamedPath}`
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: renamedPath,
        head: 'def',
        branch: 'feature/renamed',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const metaById = {
      ...store.getAllWorktreeMeta(),
      [renamedWorktreeId]: makeWorktreeMeta({ displayName: 'renamed' })
    }
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      activeWorktreeId: renamedWorktreeId,
      activeTabIdByWorktree: { [renamedWorktreeId]: 'host-tab' },
      tabsByWorktree: {
        [renamedWorktreeId]: [
          {
            id: 'host-tab',
            ptyId: null,
            worktreeId: renamedWorktreeId,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession: () => session
    }
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: `host-tab:${HEADLESS_LEAF_ID}`,
          worktreeId: TEST_WORKTREE_ID,
          state: 'working',
          prompt: 'continue after rename',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const oldSummary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)
    const renamedSummary = worktrees.find((worktree) => worktree.worktreeId === renamedWorktreeId)

    expect(oldSummary?.agents).toEqual([])
    expect(renamedSummary).toMatchObject({
      hasHostSidebarActivity: true,
      status: 'working',
      agents: [expect.objectContaining({ prompt: 'continue after rename' })]
    })
  })

  it('keeps a fresh OSC row when the cached hook row for the same pane is older', async () => {
    const leafId = '44444444-4444-4444-8444-444444444444'
    const paneKey = `tab-1:${leafId}`
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = new OrcaRuntimeService(store, undefined, statusWiring.deps)
    statusWiring.statusStore.ingestTerminalStatus({
      paneKey,
      tabId: 'tab-1',
      worktreeId: TEST_WORKTREE_ID,
      connectionId: null,
      // Keep the agent unchanged to isolate freshness from cross-agent inheritance.
      payload: { state: 'working', prompt: 'earlier hook row', agentType: 'codex' }
    })
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","prompt":"fresh OSC row","agentType":"codex"}\x07',
      321
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
    expect(summary?.agents).toEqual([
      expect.objectContaining({ paneKey, prompt: 'fresh OSC row', agentType: 'codex' })
    ])
  })

  it('drops a hydrated done hook row after its local tab is closed', async () => {
    // Hydrated hook rows for closed tabs must not reappear as current mobile activity (#6072).
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'closed-tab:66666666-6666-4666-8666-666666666666',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'closed-tab',
          state: 'done',
          prompt: 'refactor the parser',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 60_000
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({
      liveTerminalCount: 0,
      hasHostSidebarActivity: false,
      status: 'inactive',
      agents: []
    })
  })

  it('resolves legacy numeric pane keys through the stale filter too', async () => {
    // Non-UUID pane keys without a tabId field must still pass through the closed-tab filter.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'open-tab',
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'closed-tab:7',
          worktreeId: TEST_WORKTREE_ID,
          state: 'done',
          prompt: 'stale legacy pane',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 60_000
        },
        {
          paneKey: 'open-tab:9',
          worktreeId: TEST_WORKTREE_ID,
          state: 'working',
          prompt: 'live legacy pane',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ paneKey: 'open-tab:9', prompt: 'live legacy pane' })
    ])
  })
})
