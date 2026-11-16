import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { AgentHookServer } = await import('../../../agent-hooks/server/agent-hook-server')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`

const OLDER_CHECKPOINT: SleepingAgentSessionRecord = {
  paneKey: PANE_KEY,
  tabId: 'host-tab',
  worktreeId: TEST_WORKTREE_ID,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'claude-session-1' },
  prompt: 'first conversation',
  state: 'done',
  capturedAt: 100,
  updatedAt: 100,
  origin: 'live',
  connectionId: null
}

const NEWER_STATUS: AgentStatusIpcPayload = {
  paneKey: PANE_KEY,
  state: 'done',
  prompt: 'second conversation',
  agentType: 'claude',
  connectionId: null,
  receivedAt: 200,
  stateStartedAt: 200,
  tabId: 'host-tab',
  worktreeId: TEST_WORKTREE_ID,
  providerSession: { key: 'session_id', id: 'claude-session-2' }
}

describe('main-run sleep of a pane whose hook row is gone', () => {
  it.each(['live', 'exited', 'expired exit'] as const)(
    'uses a saved live conversation unless an exit was recorded (%s)',
    async (scenario) => {
      const fixture = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          sleepingAgentSessionsByPaneKey: { [PANE_KEY]: OLDER_CHECKPOINT }
        })
      )
      const server = new AgentHookServer()
      const runtime = new OrcaRuntimeService(fixture.runtimeStore, undefined, {
        getPaneAgentIdentity: (paneKey, savedRecord) =>
          server.paneAgentIdentity(paneKey, savedRecord),
        getAgentProviderSessionRowsForPane: () => [],
        checkHookAgentPresence: (paneKey, since) =>
          server.checkAgentPresenceSince(paneKey, since ?? 0)
      })
      const live = new Set(['persisted-pty'])
      runtime.setPtyController({
        write: () => true,
        kill: () => false,
        stopAndWait: async (ptyId) => {
          live.delete(ptyId)
          runtime.onPtyExit(ptyId, -1)
          return true
        },
        getForegroundProcess: async () => null,
        listProcesses: async () =>
          [...live].map((id) => ({ id, cwd: TEST_WORKTREE_PATH, title: 'claude' }))
      })
      runtime.attachWindow(1)
      await runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'claude',
            activeLeafId: HEADLESS_LEAF_ID,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: 'persisted-pty'
          }
        ]
      })
      server.setTerminalPaneLifecycle({
        ownsProcess: () => true,
        isStopping: () => false,
        isReversibleStop: () => false,
        isPlaced: () => true,
        retireSavedRecord: (paneKey, at) => runtime.retireExitedPaneResume(paneKey, at)
      })
      if (scenario !== 'live') {
        server.reconcileEndedProcessForPaneKeys([PANE_KEY], {
          endedPresence: { agent: 'claude', ended: true }
        })
        if (scenario === 'expired exit') {
          // Exit evidence can expire after a week; the saved checkpoint must already be retired.
          server.forgetAgentExit(PANE_KEY)
        }
      }
      try {
        await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
        const record = fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]
        if (scenario !== 'live') {
          expect(record).toBeUndefined()
        } else {
          expect(record).toMatchObject({
            origin: 'worktree-sleep',
            restoreOnTabOpenOnly: true,
            providerSession: { key: 'session_id', id: 'claude-session-1' }
          })
        }
      } finally {
        server.stop()
      }
    }
  )

  it('captures the checkpoint a status accepted before the sleep wrote, not the one it replaced', async () => {
    const fixture = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        sleepingAgentSessionsByPaneKey: { [PANE_KEY]: OLDER_CHECKPOINT }
      })
    )
    const statusWriteLands = deferred<void>()
    const applyLayoutCommand = fixture.runtimeStore.applyLayoutCommand.getMockImplementation()!
    fixture.runtimeStore.applyLayoutCommand.mockImplementationOnce(async (...args) => {
      await statusWriteLands.promise
      return applyLayoutCommand(...args)
    })
    const runtime = new OrcaRuntimeService(fixture.runtimeStore, undefined, {
      // The newer status was accepted, then its row went away before the sleep read the store.
      getAgentProviderSessionRowsForPane: () => [],
      checkHookAgentPresence: async () => null
    })
    const processLists = [[{ id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'claude' }]]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'persisted-pty'
        }
      ]
    })
    runtime.recordHookStatusResume(NEWER_STATUS)

    const sleeping = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    statusWriteLands.resolve()
    await sleeping

    expect(fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'claude-session-2' }
    })
  })
})
