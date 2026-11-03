import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { partialRuntimeStore } from './orca-runtime-tests/runtime-store-partial-fixture'

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('./orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('./orca-runtime')
await import('./orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-tests/orca-runtime-test-fixtures.spec')
const { bindPaneFirst, committingSpawn } =
  await import('./orca-runtime-tests/bind-first-pane.test-fixture')
const { applyWorktreeSleepResumeRecords, captureWorktreeSleepResumeRecords } =
  await import('./terminal/stop/worktree-sleep-resume-records')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const HOLDER_PANE_KEY = 'holder-tab:44444444-4444-4444-8444-444444444444'
const SESSION_ID = 'slept-provider-session'

type Verdict = 'exited' | 'unverifiable' | null

/** A hook store row as the agent hook server records it. */
function hookRow(
  fields: Partial<AgentStatusIpcPayload> &
    Pick<AgentStatusIpcPayload, 'paneKey' | 'agentType' | 'prompt' | 'receivedAt'>
): AgentStatusIpcPayload {
  return { state: 'done', stateStartedAt: fields.receivedAt, connectionId: null, ...fields }
}

function makeRuntime(
  initialVerdict: Verdict,
  holderVerdict: Verdict = null,
  sessionOverrides: Partial<WorkspaceSessionState> = {},
  rowProviderSession: AgentStatusIpcPayload['providerSession'] = {
    key: 'session_id',
    id: SESSION_ID
  }
) {
  let verdict = initialVerdict
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal(sessionOverrides)
  )
  const live = new Set<string>()
  let spawned = 0
  const spawn = vi.fn(async (_args: { worktreeId?: string; tabId?: string; leafId?: string }) => {
    const id = `host-pty-${++spawned}`
    live.add(id)
    return { id }
  })
  const row = hookRow({
    paneKey: PANE_KEY,
    agentType: 'claude',
    providerSession: rowProviderSession,
    prompt: 'first prompt',
    state: 'done',
    receivedAt: 1,
    stateStartedAt: 1,
    connectionId: null
  })
  let rows: AgentStatusIpcPayload[] = []
  const runtime = new OrcaRuntimeService(partialRuntimeStore(runtimeStore), undefined, {
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
      rows = []
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
  const reportHolder = (): void => {
    const [tabId = '', leafId = ''] = HOLDER_PANE_KEY.split(':')
    bindPaneFirst(runtime, { worktreeId: TEST_WORKTREE_ID, tabId, leafId, ptyId: 'holder-pty' })
    rows = [{ ...row, paneKey: HOLDER_PANE_KEY, tabId: 'holder-tab' }]
  }
  const setVerdict = (next: Verdict): void => {
    verdict = next
  }
  return { runtime, spawn, reportAgent, reportHolder, setVerdict, getSession }
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
    // Hand-typed launches have no saved bypass recipe; defaults must not widen their permissions.
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
    expect(spawn.mock.calls[1]?.[0]).toHaveProperty('resumeOrigin', 'saved')
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
    const launchedRow = hookRow({
      paneKey: PANE_KEY,
      agentType: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID },
      prompt: '',
      receivedAt: 1
    })
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
    const row = hookRow({
      paneKey: PANE_KEY,
      agentType: 'amp',
      prompt: '',
      receivedAt: 1
    })
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
    const row = hookRow({
      paneKey: PANE_KEY,
      agentType: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID },
      prompt: '',
      receivedAt: 1,
      connectionId: rowConnectionId
    })
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

  it('leaves a slept record out when its conversation lives in another tabbed worktree (#37799)', () => {
    const SIBLING_WORKTREE_ID = `${TEST_WORKTREE_ID}-sibling`
    const foreign = {
      paneKey: PANE_KEY,
      worktreeId: TEST_WORKTREE_ID,
      agent: 'claude' as const,
      providerSession: {
        key: 'session_id' as const,
        id: 'foreign-worktree-session',
        cwd: `${TEST_WORKTREE_ID.split('::')[1]}-sibling/pkg`
      },
      prompt: '',
      state: 'done' as const,
      capturedAt: 1,
      updatedAt: 1,
      connectionId: null
    }
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    session.tabsByWorktree = {
      ...session.tabsByWorktree,
      [SIBLING_WORKTREE_ID]: [
        {
          id: 'sibling-tab',
          ptyId: 'sibling-pty',
          worktreeId: SIBLING_WORKTREE_ID,
          title: 'Sibling',
          customTitle: null,
          color: null,
          sortOrder: 1,
          createdAt: 1
        }
      ]
    }
    const own = {
      ...foreign,
      providerSession: {
        key: 'session_id' as const,
        id: SESSION_ID,
        cwd: `${TEST_WORKTREE_ID.split('::')[1]}/pkg`
      }
    }
    const next = applyWorktreeSleepResumeRecords(
      session,
      new Map([['pty', { retiredPaneKeys: [], records: [foreign] }]]),
      ['pty']
    )
    expect(next).toBeNull()
    const kept = applyWorktreeSleepResumeRecords(
      session,
      new Map([['pty', { retiredPaneKeys: [], records: [own] }]]),
      ['pty']
    )
    expect(kept?.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.providerSession.id).toBe(SESSION_ID)
  })
})

describe('reopen refuses a conversation that lives in another tabbed worktree (#37799)', () => {
  const SIBLING_WORKTREE_ID = `${TEST_WORKTREE_ID}-sibling`
  const SIBLING_CWD = `${TEST_WORKTREE_ID.split('::')[1]}-sibling/pkg`

  function sessionWithSiblingWorktree(
    overrides: Partial<WorkspaceSessionState> = {}
  ): Partial<WorkspaceSessionState> {
    const base = makeWorkspaceSessionWithHeadlessTerminal()
    return {
      ...overrides,
      tabsByWorktree: {
        ...base.tabsByWorktree,
        [SIBLING_WORKTREE_ID]: [
          {
            id: 'sibling-tab',
            ptyId: 'sibling-pty',
            worktreeId: SIBLING_WORKTREE_ID,
            title: 'Sibling',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      }
    }
  }

  it('reopen keeps a plain shell when a stored record names the sibling worktree', async () => {
    const { runtime, spawn } = makeRuntime(
      null,
      null,
      sessionWithSiblingWorktree({
        sleepingAgentSessionsByPaneKey: {
          [PANE_KEY]: {
            paneKey: PANE_KEY,
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            agent: 'claude',
            providerSession: { key: 'session_id', id: SESSION_ID, cwd: SIBLING_CWD },
            prompt: '',
            state: 'done',
            capturedAt: 1,
            updatedAt: 1,
            connectionId: null,
            origin: 'live'
          }
        }
      })
    )

    await userActivate(runtime)

    expect(spawnCommand(spawn, 0).includes(SESSION_ID)).toBe(false)
  })

  it('reopen adopts neither a slept capture nor hook rows naming the sibling worktree', async () => {
    const { runtime, spawn, reportAgent } = makeRuntime(null, null, sessionWithSiblingWorktree(), {
      key: 'session_id',
      id: 'foreign-session',
      cwd: SIBLING_CWD
    })
    await userActivate(runtime)
    reportAgent()
    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)

    await userActivate(runtime)

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawnCommand(spawn, 1).includes('foreign-session')).toBe(false)
  })
})
