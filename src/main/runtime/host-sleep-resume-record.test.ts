// A paired client's sleep stops the host's PTYs; the host must keep the session to resume on open.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')
const { bindPaneFirst, committingSpawn } = await import('./bind-first-pane.test-fixture')
const { applyWorktreeSleepResumeRecords, captureWorktreeSleepResumeRecords } =
  await import('./terminal/stop/worktree-sleep-resume-records')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const HOLDER_PANE_KEY = 'holder-tab:44444444-4444-4444-8444-444444444444'
const SESSION_ID = 'slept-provider-session'

type Verdict = 'exited' | 'unverifiable' | null

function makeRuntime(initialVerdict: Verdict, holderVerdict: Verdict = null) {
  let verdict = initialVerdict
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const live = new Set<string>()
  let spawned = 0
  const spawn = vi.fn(async (_args: { worktreeId?: string; tabId?: string; leafId?: string }) => {
    const id = `host-pty-${++spawned}`
    live.add(id)
    return { id }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook row reads only the fields the sleep capture uses.
  const row = {
    paneKey: PANE_KEY,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: SESSION_ID },
    prompt: 'first prompt',
    state: 'done',
    receivedAt: 1,
    stateStartedAt: 1,
    connectionId: null
  } as AgentStatusIpcPayload
  let rows: AgentStatusIpcPayload[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements the runtime store methods these tests reach.
  const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
    getAgentProviderSessionSnapshot: () => rows,
    checkHookAgentPresence: async (paneKey: string) =>
      paneKey === HOLDER_PANE_KEY ? holderVerdict : verdict
  })
  runtime.setPtyController({
    spawn: committingSpawn(runtime, spawn),
    write: () => true,
    kill: () => true,
    stopAndWait: async (ptyId: string) => {
      live.delete(ptyId)
      // A PTY's exit clears its hook row, as the host's teardown does.
      rows = []
      // Why: stopAndWait resolves after the provider's exit; main's layout keeps the pane bound.
      runtime.onPtyExit(ptyId, 0)
      return true
    },
    getForegroundProcess: async () => null,
    listProcesses: async () =>
      [...live].map((id) => ({ id, worktreeId: TEST_WORKTREE_ID, cwd: '/tmp', title: 'Claude' }))
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const reportAgent = (): void => {
    rows = [row]
  }
  // The session resumed by hand in another pane whose shell outlived it; main's layout holds it.
  const reportHolder = (): void => {
    const [tabId = '', leafId = ''] = HOLDER_PANE_KEY.split(':')
    bindPaneFirst(runtime, { worktreeId: TEST_WORKTREE_ID, tabId, leafId, ptyId: 'holder-pty' })
    rows = [{ ...row, paneKey: HOLDER_PANE_KEY, tabId: 'holder-tab' }]
  }
  const setVerdict = (next: Verdict): void => {
    verdict = next
  }
  return { runtime, spawn, reportAgent, reportHolder, setVerdict }
}

function userActivate(runtime: InstanceType<typeof OrcaRuntimeService>) {
  return runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
    notifyClients: false,
    navigation: 'caller',
    intent: 'user'
  })
}

function spawnCommand(spawn: ReturnType<typeof vi.fn>, call: number): string {
  const args: unknown = spawn.mock.calls[call]?.[0]
  return typeof args === 'object' && args !== null && 'command' in args
    ? String(args.command ?? '')
    : ''
}

describe('host-driven worktree sleep keeps the slept agent resumable', () => {
  it.each([
    [null, true],
    ['unverifiable', true],
    ['exited', false]
  ] as const)('agent verdict %s at sleep: reopen resumes %s', async (verdict, resumes) => {
    const { runtime, spawn, reportAgent } = makeRuntime(verdict)
    await userActivate(runtime)
    expect(spawn).toHaveBeenCalledOnce()
    reportAgent()

    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await userActivate(runtime)

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawnCommand(spawn, 1).includes(SESSION_ID)).toBe(resumes)
    // A hand-typed `claude` recorded no recipe; the settings default bypass must not widen it.
    expect(spawnCommand(spawn, 1)).not.toContain('--dangerously-skip-permissions')
  })

  it('resumes an Orca-launched session with the recipe its launch recorded', async () => {
    const { runtime, spawn, reportAgent } = makeRuntime(null)
    await userActivate(runtime)
    reportAgent()
    const launchConfig = { agentArgs: '--dangerously-skip-permissions', agentEnv: {} }
    const pty = [...runtime['ptysById'].values()][0]!
    pty.launchAgent = 'claude'
    pty.launchConfig = launchConfig

    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await userActivate(runtime)

    expect(spawnCommand(spawn, 1)).toContain('--dangerously-skip-permissions')
    expect(spawnCommand(spawn, 1)).toContain(SESSION_ID)
  })

  it.each([
    ['exited', true],
    ['unverifiable', false]
  ] as const)('another pane holding the session %s: reopen resumes %s', async (holder, resumes) => {
    const { runtime, spawn, reportAgent, reportHolder } = makeRuntime(null, holder)
    await userActivate(runtime)
    reportAgent()
    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    reportHolder()

    await userActivate(runtime)

    expect(spawnCommand(spawn, 1).includes(SESSION_ID)).toBe(resumes)
  })

  it.each([
    [null, true],
    ['exited', false]
  ] as const)(
    're-slept before its first hook, verdict %s: reopen resumes %s',
    async (v, resumes) => {
      const { runtime, spawn, reportAgent, setVerdict } = makeRuntime(null)
      await userActivate(runtime)
      reportAgent()
      await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
      await userActivate(runtime)
      // The resumed agent has not reported yet, so the host holds no row for the pane.
      setVerdict(v)
      await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)

      await userActivate(runtime)

      expect(spawn).toHaveBeenCalledTimes(3)
      expect(spawnCommand(spawn, 2).includes(SESSION_ID)).toBe(resumes)
    }
  )

  it.each([
    ['claude', true],
    ['codex', false]
  ] as const)('keeps a %s-launched PTY recipe: %s', async (launchAgent, kept) => {
    const config = { agentCommand: '/opt/claude-custom', agentArgs: '--x', agentEnv: {} }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only these row fields.
    const launchedRow = {
      paneKey: PANE_KEY,
      agentType: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID },
      prompt: '',
      receivedAt: 1
    } as AgentStatusIpcPayload
    const capture = await captureWorktreeSleepResumeRecords({
      worktreeId: TEST_WORKTREE_ID,
      paneKeysByPtyId: new Map([['pty', [PANE_KEY]]]),
      launchByPtyId: new Map([['pty', { agent: launchAgent, config }]]),
      readRows: () => [launchedRow],
      checkAgentPresence: null,
      capturedAt: 2
    })
    expect(capture.get('pty')?.records[0]?.launchConfig).toEqual(kept ? config : undefined)
  })

  it('retires an older capture when the hook store names a non-resumable agent in the pane', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only these row fields.
    const row = {
      paneKey: PANE_KEY,
      agentType: 'amp',
      prompt: '',
      receivedAt: 1
    } as AgentStatusIpcPayload
    const capture = await captureWorktreeSleepResumeRecords({
      worktreeId: TEST_WORKTREE_ID,
      paneKeysByPtyId: new Map([['pty', [PANE_KEY]]]),
      launchByPtyId: new Map(),
      readRows: () => [row],
      checkAgentPresence: async () => 'unverifiable',
      capturedAt: 2
    })
    expect(capture.get('pty')).toEqual({ retiredPaneKeys: [PANE_KEY], records: [] })
  })

  it.each([
    [null, null],
    ['wsl:Ubuntu', null],
    ['ssh-target', 'ssh-target']
  ] as const)('stamps hook connection %s as host %s', async (rowConnectionId, stamped) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only these row fields.
    const row = {
      paneKey: PANE_KEY,
      agentType: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID },
      prompt: '',
      receivedAt: 1,
      connectionId: rowConnectionId
    } as AgentStatusIpcPayload
    const capture = await captureWorktreeSleepResumeRecords({
      worktreeId: TEST_WORKTREE_ID,
      paneKeysByPtyId: new Map([['pty', [PANE_KEY]]]),
      launchByPtyId: new Map(),
      readRows: () => [row],
      checkAgentPresence: null,
      capturedAt: 2
    })
    expect(capture.get('pty')?.records[0]?.connectionId).toBe(stamped)
  })

  it('stamps the SSH host and keeps the saved recipe a reattached PTY forgot', () => {
    const launchConfig = { agentArgs: '--x', agentEnv: {} }
    const record = {
      paneKey: PANE_KEY,
      worktreeId: TEST_WORKTREE_ID,
      agent: 'claude' as const,
      providerSession: { key: 'session_id' as const, id: SESSION_ID },
      prompt: '',
      state: 'done' as const,
      capturedAt: 1,
      updatedAt: 1,
      connectionId: 'ssh-target'
    }
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: { ...record, launchConfig } }
    })
    const next = applyWorktreeSleepResumeRecords(
      session,
      new Map([['pty', { retiredPaneKeys: [], records: [{ ...record, capturedAt: 2 }] }]]),
      ['pty']
    )
    expect(next?.sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      capturedAt: 2,
      connectionId: 'ssh-target',
      launchConfig
    })
  })
})
