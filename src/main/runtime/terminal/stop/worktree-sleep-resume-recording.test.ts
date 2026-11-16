import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { AgentHookServer } = await import('../../../agent-hooks/server/agent-hook-server')
const { agentHookRuntimeDeps } =
  await import('../../../agent-hooks/runtime/agent-hook-runtime-deps')
const { AgentStatusObservedPaneIdentities } =
  await import('../identity/agent-status-observed-pane-identity')
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
  it.each(['live', 'working', 'interrupted', 'exited', 'expired exit'] as const)(
    'uses a saved live conversation unless an exit was recorded (%s)',
    async (scenario) => {
      const fixture = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          sleepingAgentSessionsByPaneKey: {
            [PANE_KEY]: {
              ...OLDER_CHECKPOINT,
              ...(scenario === 'working' ? { state: 'working' as const } : {}),
              ...(scenario === 'interrupted' ? { interrupted: true } : {})
            }
          }
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
      if (scenario === 'exited' || scenario === 'expired exit') {
        server.reconcileEndedProcessForPaneKeys([PANE_KEY], {
          confirmedExit: true
        })
        if (scenario === 'expired exit') {
          // Exit evidence can expire after a week; the saved checkpoint must already be retired.
          server.forgetAgentExit(PANE_KEY)
        }
      }
      try {
        await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
        const record = fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]
        if (scenario === 'exited' || scenario === 'expired exit') {
          expect(record).toBeUndefined()
        } else {
          expect(record).toMatchObject({
            origin: 'worktree-sleep',
            restoreOnTabOpenOnly: true,
            providerSession: { key: 'session_id', id: 'claude-session-1' }
          })
          if (scenario === 'working' || scenario === 'interrupted') {
            expect(record?.interrupted).toBe(true)
          }
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

it.each([100, 1000])(
  'skips durable session transactions for %s exits without recovery records',
  async (count) => {
    const fixture = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
    const runtime = new OrcaRuntimeService(fixture.runtimeStore)
    vi.spyOn(runtime, 'getTerminalWorktreeIdForPaneKey').mockReturnValue(TEST_WORKTREE_ID)
    const durableMutation = vi.spyOn(fixture.runtimeStore, 'runDurableMutation')
    for (let i = 0; i < count; i++) {
      runtime.retireExitedPaneResume(`absent-tab-${i}:11111111-1111-4111-8111-111111111111`, 200)
    }
    await runtime.readSavedResumeSource(TEST_WORKTREE_ID, PANE_KEY)
    expect(durableMutation).not.toHaveBeenCalled()
  }
)

describe('a hookless resumed Codex across wakes and shell-confirmed command finishes', () => {
  const SESSION = { key: 'session_id' as const, id: 'woken-codex' }
  const SLEPT: SleepingAgentSessionRecord = {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'codex',
    providerSession: SESSION,
    prompt: '',
    state: 'done',
    capturedAt: 100,
    updatedAt: 100,
    origin: 'worktree-sleep',
    restoreOnTabOpenOnly: true,
    connectionId: null
  }

  it.each([
    ['quit', ['0'], false],
    ['suspended', ['148'], true],
    ['suspended, then another command', ['148', '0'], true]
  ] as const)('%s', async (_, finishes, keepsRecovery) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const tick = () => vi.setSystemTime(Date.now() + 1_000)
    const fixture = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        sleepingAgentSessionsByPaneKey: { [PANE_KEY]: SLEPT }
      })
    )
    const server = new AgentHookServer()
    const runtime = new OrcaRuntimeService(fixture.runtimeStore, undefined, {
      ...agentHookRuntimeDeps(server, new AgentStatusObservedPaneIdentities(), () => ({})),
      retireAgentHookCompatibilityAuthority: (paneKey, options) =>
        server.retireProcessAuthority(paneKey, options)
    })
    server.setTerminalPaneLifecycle({
      ownsProcess: () => true,
      isStopping: () => false,
      isReversibleStop: () => false,
      isPlaced: () => true,
      readSavedRecord: (paneKey) => fixture.getSession().sleepingAgentSessionsByPaneKey?.[paneKey],
      retireSavedRecord: (paneKey, at) => runtime.retireExitedPaneResume(paneKey, at)
    })
    const live = new Set<string>()
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
        [...live].map((id) => ({ id, cwd: TEST_WORKTREE_PATH, title: 'codex' }))
    })
    runtime.attachWindow(1)
    // Orca's wake relaunches the saved conversation; Codex posts no hook until a new turn.
    const wake = async (ptyId: string) => {
      tick()
      live.add(ptyId)
      const binding = { tabId: 'host-tab', leafId: HEADLESS_LEAF_ID, incarnationId: ptyId }
      await runtime.syncWindowGraph(1, {
        tabs: [
          {
            ...binding,
            worktreeId: TEST_WORKTREE_ID,
            title: 'codex',
            activeLeafId: HEADLESS_LEAF_ID,
            layout: null
          }
        ],
        leaves: [{ ...binding, worktreeId: TEST_WORKTREE_ID, ptyId, paneRuntimeId: 1 }]
      })
      runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
        ...binding,
        agentLaunchAuthority: { launchToken: `${ptyId}-launch`, launchAgent: 'codex' }
      })
      server.recordLaunchResumeIdentity({
        paneKey: PANE_KEY,
        worktreeId: TEST_WORKTREE_ID,
        agentType: 'codex',
        providerSession: SESSION,
        launchedAt: Date.now()
      })
    }
    const saved = () => runtime.readSavedResumeSource(TEST_WORKTREE_ID, PANE_KEY)
    const sleep = async () => {
      tick()
      await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
      return saved()
    }
    const resumable = { agent: 'codex', providerSession: SESSION, origin: 'worktree-sleep' }
    try {
      // #42864: an idle resumed Codex keeps its conversation across two sleeps.
      await wake('pty-1')
      expect(await sleep()).toMatchObject(resumable)
      await wake('pty-2')
      expect(await sleep()).toMatchObject(resumable)

      await wake('pty-3')
      for (const status of finishes) {
        tick()
        runtime.onPtyData('pty-3', `\x1b]133;D;${status}\x07`, Date.now())
      }
      // A quit retires the saved conversation itself, before its exit evidence can expire.
      expect(await saved()).toEqual(keepsRecovery ? expect.objectContaining(resumable) : undefined)
      server.forgetAgentExit(PANE_KEY)
      expect(await sleep()).toEqual(keepsRecovery ? expect.objectContaining(resumable) : undefined)

      // Orca relaunching the same conversation owns the pane again through later sleeps.
      await wake('pty-4')
      expect(await sleep()).toMatchObject(resumable)
      await wake('pty-5')
      expect(await sleep()).toMatchObject(resumable)
    } finally {
      server.stop()
      vi.useRealTimers()
    }
  })
})
