import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload
} from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('../../construction/test-context/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../construction/test-context/orca-runtime-test-lifecycle.spec')
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
  syncSinglePty,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../construction/test-context/orca-runtime-test-fixtures.spec')

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
      if (scenario === 'live' || scenario === 'working') {
        // A running pane's saved live checkpoint is not proof it still owns that conversation.
        expect(runtime.quitResumeRecordsFor(fixture.getSession())).toEqual([])
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
          // Quitting while asleep keeps the sleep record rather than rewriting it as a quit.
          expect(runtime.quitResumeRecordsFor(fixture.getSession())).toEqual([])
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
    ['quit without command marks', ['unmarked'], false],
    ['a shell nested in the live Codex finishing a command', ['nested'], true],
    ['a nested shell finishing a command, then quit', ['nested', '0'], false],
    ['suspended', ['148'], true],
    ['macOS suspended', ['146'], true],
    ['suspended, then another command', ['148', '0'], true],
    ['macOS suspended, then another command', ['146', '0'], true],
    ['macOS suspended, then a listing and another command', ['146', 'listing', '0'], true],
    ['suspended, resumed (fg), then quit', ['148', 'fg', '0'], false],
    // A restored receipt whose launch already finished leaves the quit to the shell-alone proof.
    ['macOS suspended, resumed (fg), a listing, then quit', ['146', 'fg', 'listing', '0'], false],
    // A stop-like status is no proof: an agent that exits 146 for real is gone at that mark.
    ['quit with a stop-like exit status', ['exit146'], false],
    ['quit, then sleep while its exit proof still runs', ['quit-then-sleep'], false],
    ['quit where the host gives no shell proof (remote, Windows)', ['unproven'], false],
    ['quit of an agent no Orca launch held (typed at the prompt)', ['typed'], false],
    ['quit of a typed agent on Windows, whose host gives no shell proof', ['typed-windows'], false]
  ] as const)('%s', async (_, finishes, keepsRecovery) => {
    const platform = process.platform
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const tick = () => vi.setSystemTime(Date.now() + 1_000)
    // The host's word on the pane's shell: alone unless a nested shell marked a command.
    let shellAlone: boolean | null = true
    let stopped = false
    let proofGate: Promise<void> = Promise.resolve()
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
      confirmProcessExit: async () => true,
      confirmShellAlone: async () => {
        await proofGate
        return shellAlone
      },
      retireSavedRecord: (paneKey, at) => runtime.retireExitedPaneResume(paneKey, at)
    })
    const clears: AgentStatusClearIpcPayload[] = []
    server.subscribePaneStatusClear((clear) => clears.push(clear))
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
      // The window saves the woken terminal into the pane's layout; a sleep checkpoints only the
      // pane its stopped terminal still holds.
      const session = fixture.getSession()
      const layout = session.terminalLayoutsByTabId?.['host-tab']
      if (layout) {
        fixture.setSession({
          ...session,
          terminalLayoutsByTabId: {
            ...session.terminalLayoutsByTabId,
            'host-tab': { ...layout, ptyIdsByLeafId: { [HEADLESS_LEAF_ID]: ptyId } }
          }
        })
      }
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
        if (status === 'unmarked') {
          await server.reconcilePaneProcessExit(PANE_KEY)
        } else if (status === 'typed-windows') {
          Object.defineProperty(process, 'platform', { value: 'win32' })
          shellAlone = null
          server.retireProcessAuthority(PANE_KEY, { confirmedExit: true, launchRetired: true })
          await new Promise((resolve) => setImmediate(resolve))
          Object.defineProperty(process, 'platform', { value: platform })
        } else if (status === 'typed') {
          // The runtime's notice for a mark that finds no launch held.
          server.retireProcessAuthority(PANE_KEY, { confirmedExit: true, launchRetired: true })
          await new Promise((resolve) => setImmediate(resolve))
        } else if (status === 'quit-then-sleep') {
          let release = (): void => {}
          proofGate = new Promise((resolve) => {
            release = resolve
          })
          shellAlone = true
          runtime.onPtyData('pty-3', '\x1b]133;C\x07\x1b]133;D;0\x07', Date.now())
          // The sleep starts before the process table answers; it must read the quit it proves.
          const slept = sleep()
          await new Promise((resolve) => setImmediate(resolve))
          release()
          expect(await slept).toBeUndefined()
        } else if (status === 'fg') {
          stopped = false
        } else if (status === 'listing') {
          // An inventory refresh (`orca worktree ps`) re-mints the restored surface's receipt.
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reaches the protected receipt minter the listing path calls.
          const internals = runtime as unknown as {
            ptysById: Map<string, unknown>
            rememberRestoredOrchestrationAuthority(pty: unknown, handle: string, id: string): void
          }
          internals.rememberRestoredOrchestrationAuthority(
            internals.ptysById.get('pty-3'),
            'term-3',
            'pty-3'
          )
        } else {
          stopped ||= status === '148' || status === '146'
          shellAlone = status === 'unproven' ? null : status !== 'nested' && !stopped
          const code =
            status === 'exit146'
              ? '146'
              : status === 'nested' || status === 'unproven'
                ? '0'
                : status
          runtime.onPtyData('pty-3', `\x1b]133;C\x07\x1b]133;D;${code}\x07`, Date.now())
          // Let the host's shell-alone answer land.
          await new Promise((resolve) => setImmediate(resolve))
        }
      }
      expect(clears.filter((clear) => 'paneKey' in clear && clear.refusedResume)).toEqual(
        keepsRecovery
          ? []
          : [
              expect.objectContaining({
                paneKey: PANE_KEY,
                refusedResume: expect.objectContaining({
                  agent: 'codex',
                  providerSession: { key: 'session_id', id: 'woken-codex' }
                })
              })
            ]
      )
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

it.each([
  ['locally suspended', true, 'zsh', []],
  ['SSH or undecided owner at the shell', false, 'zsh', ['agent-exited']],
  ['unanswered foreground', false, null, []],
  ['agent still foreground', false, 'claude', []]
] as const)(
  'confirms title exit using process evidence: %s',
  async (_, suspended, foreground, expected) => {
    const fixture = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
    const exits: string[] = []
    const checked = deferred<void>()
    const runtime = new OrcaRuntimeService(fixture.runtimeStore, undefined, {
      checkHookAgentPresence: async () => {
        checked.resolve()
        return 'unverifiable'
      },
      getPaneAgentIdentity: () => ({
        status: NEWER_STATUS,
        ended: false,
        ...(suspended ? { suspended: true } : {})
      }),
      onTerminalSideEffects: (batch) => {
        for (const fact of batch.facts) {
          if (fact.kind === 'agent-exited') {
            exits.push(fact.kind)
          }
        }
      }
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      getForegroundProcess: async () => foreground
    })
    await syncSinglePty(runtime)
    runtime.onPtyData('pty-1', '\x1b]0;✳ Claude Code\x07', 100)
    runtime.onPtyData('pty-1', '\x1b]0;zsh\x07', 101)
    await checked.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(exits).toEqual(expected)
  }
)
