import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

const PTY_ID = 'pty-omp-command-finished'
const INCARNATION = 'omp-incarnation-1'
const WORKTREE_ID = 'path:/tmp/omp-status-lifetime'
const TAB_ID = '9a80b65d-34bf-47f7-b507-20dcae366a01'
const LEAF_ID = '9a80b65d-34bf-47f7-b507-20dcae366a02'
const HANDLE = 'term_omp-status-lifetime'
const LAUNCH_TOKEN = 'omp-status-lifetime-token'
const CAPTURED_OMP_COMMAND_FINISHED = '\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07'

class StatusRuntime extends OrcaRuntimeService {
  bindPane(incarnationId = INCARNATION): void {
    this.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId,
      agentLaunchAuthority: { launchToken: LAUNCH_TOKEN, launchAgent: 'omp' }
    })
    this.adoptControllerTerminalHandle(PTY_ID, HANDLE, incarnationId)
  }

  async restoreInventory(handle: string): Promise<void> {
    await this.refreshPtyWorktreeRecordsWithControllerInventory([], WORKTREE_ID)
    expect(this.restoredOrchestrationAuthorityByPtyId.get(PTY_ID)?.terminalHandle).toBe(handle)
  }

  retireLaunch(): void {
    this.retirePtyAgentLaunchAuthority(PTY_ID)
  }

  replaceIncarnation(): void {
    this.bindPane('omp-incarnation-2')
  }
}

const servers: AgentHookServer[] = []
const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function createPane(getForegroundProcess: () => Promise<string | null>) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-omp-lifetime-'))
  directories.push(directory)
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: directory })
  const runtime = new StatusRuntime(
    {
      ...makeStore(),
      getGitHubCache: () => ({ pr: {}, issue: {} }),
      getSettings: () => ({
        ...makeStore().getSettings(),
        refreshLocalBaseRefOnWorktreeCreate: false
      }),
      getWorkspaceSession: () => ({
        activeRepoId: null,
        activeWorktreeId: WORKTREE_ID,
        activeTabId: TAB_ID,
        tabsByWorktree: {
          [WORKTREE_ID]: [
            {
              id: TAB_ID,
              ptyId: PTY_ID,
              worktreeId: WORKTREE_ID,
              title: 'OMP',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
          }
        },
        terminalPtyIncarnationsByPaneKey: { [`${TAB_ID}:${LEAF_ID}`]: INCARNATION }
      })
    },
    undefined,
    {
      retireAgentHookCompatibilityAuthority: (paneKey) => server.retirePaneAuthority(paneKey),
      getAgentStatusSnapshot: () => server.getStatusSnapshot(),
      getAgentProviderSessionSnapshot: () => server.getStatusSnapshot(),
      getAgentProviderSessionRowsForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
      attestAgentHookCompatibilityAuthority: (candidate) =>
        server.attestCompatibilityAuthority(candidate)
    }
  )
  const handle = HANDLE
  const controller = {
    spawn: async () => ({ id: PTY_ID, incarnationId: INCARNATION }),
    write: () => true,
    kill: () => true,
    getForegroundProcess,
    listProcesses: async () => [
      {
        id: PTY_ID,
        terminalHandle: handle,
        incarnationId: INCARNATION,
        worktreeId: WORKTREE_ID,
        title: 'omp',
        cwd: '/tmp/omp-status-lifetime'
      }
    ]
  }
  runtime.setPtyController(controller)
  runtime.bindPane()
  const paneKey = `${TAB_ID}:${LEAF_ID}`
  const hookEnv = server.buildPtyEnv()
  const post = async (payload: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${hookEnv.ORCA_AGENT_HOOK_PORT}/hook/omp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': hookEnv.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey,
        tabId: paneKey.split(':')[0],
        worktreeId: WORKTREE_ID,
        launchToken: LAUNCH_TOKEN,
        env: 'production',
        payload
      })
    })
    expect(response.status).toBe(204)
  }
  const state = () => server.getStatusSnapshot().find((row) => row.paneKey === paneKey)?.state
  await post({ hook_event_name: 'before_agent_start' })
  expect(state()).toBe('working')
  return { runtime, server, controller, paneKey, handle, post, state }
}

for (const path of ['bytes', 'daemon'] as const) {
  const commandFinished = (runtime: OrcaRuntimeService): void => {
    if (path === 'bytes') {
      runtime.onPtyData(PTY_ID, CAPTURED_OMP_COMMAND_FINISHED, Date.now())
    } else {
      runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })
    }
  }

  describe(`OMP command-finished lifetime (${path})`, () => {
    it.each([
      ['live OMP', async () => 'omp'],
      ['unknown foreground', async () => null],
      ['another foreground command', async () => 'sleep'],
      [
        'unavailable execution host',
        async () => {
          throw new Error('transport unavailable')
        }
      ]
    ])('preserves completion with %s and admits the next turn', async (_label, foreground) => {
      const pane = await createPane(foreground)
      await pane.post({ hook_event_name: 'agent_end' })
      expect(pane.state()).toBe('done')
      commandFinished(pane.runtime)
      await settle()
      expect(pane.state()).toBe('done')
      await pane.post({ hook_event_name: 'before_agent_start' })
      expect(pane.state()).toBe('working')
      commandFinished(pane.runtime)
      await settle()
      await pane.post({ hook_event_name: 'agent_end' })
      expect(pane.state()).toBe('done')
    })

    it('keeps status after inventory restores launch authority', async () => {
      const pane = await createPane(async () => 'omp')
      pane.runtime.retireLaunch()
      await pane.post({ hook_event_name: 'before_agent_start' })
      await pane.runtime.restoreInventory(pane.handle)
      commandFinished(pane.runtime)
      await settle()
      expect(pane.state()).toBe('working')
      await pane.post({ hook_event_name: 'agent_end', has_active_jobs: true })
      expect(pane.state()).toBe('working')
      commandFinished(pane.runtime)
      await settle()
      await pane.post({
        hook_event_name: 'agent_end',
        has_active_jobs: false,
        has_pending_messages: false
      })
      expect(pane.state()).toBe('done')
    })

    it('preserves an open input dialog and session reset readiness', async () => {
      const pane = await createPane(async () => 'omp')
      await pane.post({ hook_event_name: 'ui_prompt_start', ui_prompt_active: true })
      expect(pane.state()).toBe('waiting')
      commandFinished(pane.runtime)
      await settle()
      expect(pane.state()).toBe('waiting')
      await pane.post({ hook_event_name: 'ui_prompt_end', is_idle: false })
      expect(pane.state()).toBe('working')
      await pane.post({ hook_event_name: 'agent_end' })
      await pane.post({
        hook_event_name: 'session_switch',
        is_idle: true,
        has_active_jobs: false,
        has_pending_messages: false
      })
      commandFinished(pane.runtime)
      await settle()
      expect(pane.state()).toBe('done')
    })

    it.each([
      ['new session', 'new-session', true],
      ['new turn in the same session', 'old-session', true],
      ['fresh activity without a state change', 'old-session', false]
    ] as const)('ignores an old shell read after %s', async (_label, sessionId, completeTurn) => {
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
      let releaseForeground: ((process: string | null) => void) | undefined
      let markReadStarted: (() => void) | undefined
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve
      })
      const foreground = new Promise<string | null>((resolve) => {
        releaseForeground = resolve
      })
      const pane = await createPane(() => {
        markReadStarted?.()
        return foreground
      })
      await pane.post({ hook_event_name: 'before_agent_start', session_id: 'old-session' })
      if (completeTurn) {
        await pane.post({ hook_event_name: 'agent_end', session_id: 'old-session' })
      }
      commandFinished(pane.runtime)
      await readStarted
      commandFinished(pane.runtime)
      await pane.post({ hook_event_name: 'before_agent_start', session_id: sessionId })
      releaseForeground?.('zsh')
      await settle()
      expect(pane.state()).toBe('working')
      expect(pane.server.getStatusSnapshotForPane(pane.paneKey)[0]?.providerSession?.id).toBe(
        sessionId
      )
      expect(
        pane.runtime.getOrchestrationDispatchAuthority(pane.handle)?.launchTokenHash
      ).not.toBeNull()
      commandFinished(pane.runtime)
      await settle()
      expect(pane.state()).toBeUndefined()
      expect(
        pane.runtime.getOrchestrationDispatchAuthority(pane.handle)?.launchTokenHash
      ).toBeNull()
    })

    it('retires authority only when the execution host confirms a shell', async () => {
      const pane = await createPane(async () => 'zsh')
      await pane.post({ hook_event_name: 'agent_end' })
      commandFinished(pane.runtime)
      await settle()
      expect(pane.state()).toBeUndefined()
      await pane.post({ hook_event_name: 'agent_end' })
      expect(pane.state()).toBeUndefined()
    })

    it.each(['controller', 'incarnation'] as const)(
      'ignores a shell read from an old %s',
      async (replacement) => {
        let resolveForeground: ((process: string | null) => void) | undefined
        const foreground = new Promise<string | null>((resolve) => {
          resolveForeground = resolve
        })
        const pane = await createPane(() => foreground)
        await pane.post({ hook_event_name: 'agent_end' })
        commandFinished(pane.runtime)
        if (replacement === 'controller') {
          pane.runtime.setPtyController({
            ...pane.controller,
            getForegroundProcess: async () => 'omp'
          })
        } else {
          pane.runtime.replaceIncarnation()
        }
        resolveForeground?.('zsh')
        await settle()
        expect(pane.state()).toBe('done')
      }
    )
  })
}
