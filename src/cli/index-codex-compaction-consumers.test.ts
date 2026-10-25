import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../main/agent-hooks/server'
import { buildBody, PANE, postHookEvent } from '../main/agent-hooks/server.test-fixtures'
import {
  createTranscriptPane,
  waitForTranscriptIdle
} from '../main/runtime/agent-transcript-pane-test-harness'
import type { ResolvedWorktreeSnapshot } from '../main/runtime/runtime-resolved-worktree-cache'
import * as stores from '../renderer/src/store/slices/store-test-helpers'
import { buildWindowApi } from '../renderer/src/hooks/ipc-events-agent-status-window-test-fixtures'
import { toAgentStatusIpcPayload } from '../main/agent-hooks/server/server-status-identity'

const mocks = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp')
}))
vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness')
  return createRuntimeClientModuleMock(mocks)
})
vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
import { main } from './index'

function codexCompactionSequence(state: 'done' | 'waiting'): Record<string, unknown>[] {
  return [
    { hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'Do work' },
    state === 'done'
      ? { hook_event_name: 'Stop', turn_id: 'turn-1' }
      : {
          hook_event_name: 'PreToolUse',
          turn_id: 'turn-1',
          tool_name: 'request_user_input',
          tool_input: { questions: [{ id: 'choice', question: 'Which option?' }] }
        },
    { hook_event_name: 'SessionStart', source: 'compact' }
  ].map((payload) => ({ session_id: 'compact-session', ...payload }))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it.each(['done', 'waiting'] as const)(
  'keeps compacted %s through runtime consumers and CLI commands',
  async (state) => {
    const server = new AgentHookServer()
    const store = stores.createTestStore()
    store.setState({
      workspaceSessionReady: true,
      tabsByWorktree: { 'wt-1': [stores.makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    })
    vi.doMock('../renderer/src/store', () => ({ useAppStore: store }))
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (listener) => {
          server.setListener((row) => listener(toAgentStatusIpcPayload(row)))
          return () => server.setListener(null)
        },
        getSnapshot: async () => server.getStatusSnapshot()
      })
    )
    const { registerAgentStatusIpcBridge } =
      await import('../renderer/src/hooks/ipc-events/agent-status-ipc-bridge')
    const unsubs: (() => void)[] = []
    let bridge = registerAgentStatusIpcBridge(unsubs)
    const stopBridge = () => {
      bridge.disposeAsyncState()
      bridge.unsubscribeStore()
      unsubs.splice(0).forEach((fn) => fn())
    }
    await server.start({ env: 'production' })
    const pane = await createTranscriptPane(
      {
        paneTitle: 'Codex',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: '• Working (4s • esc to interrupt)\r\n'
      },
      {
        getAgentStatusSnapshot: () => server.getStatusSnapshot(),
        getAgentProviderSessionRowsForPane: () => server.getStatusSnapshot()
      }
    )
    const { runtime, handle } = pane
    const worktree = stores.makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo/app' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: expose only the existing protected inventory seam; status projections stay real.
    const inventory = runtime as unknown as {
      listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot>
    }
    vi.spyOn(inventory, 'listResolvedWorktreeSnapshot').mockResolvedValue({
      worktrees: [
        { ...worktree, parentWorktreeId: null, childWorktreeIds: [], lineage: null, git: worktree }
      ],
      platformByRepoId: new Map()
    })
    vi.stubEnv('ORCA_PAIRING_CODE', '')
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exitCode = process.exitCode
    try {
      for (const payload of codexCompactionSequence(state)) {
        const body = buildBody(payload, { launchToken: 'transcript-launch' })
        expect((await postHookEvent(server, body, '/hook/codex')).status).toBe(204)
      }
      const expected = { state, providerSession: { id: 'compact-session' } }
      await vi.waitFor(() =>
        expect(store.getState().agentStatusByPaneKey[PANE]).toMatchObject(expected)
      )
      stopBridge()
      store.setState({ agentStatusByPaneKey: {} })
      bridge = registerAgentStatusIpcBridge(unsubs)
      await vi.waitFor(() =>
        expect(store.getState().agentStatusByPaneKey[PANE]).toMatchObject(expected)
      )
      store.getState().captureAllSleepingAgentSessions('quit')
      expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]).toMatchObject(expected)
      const tabs = await runtime.listMobileSessionTabs('id:wt-1')
      expect(tabs.tabs[0]).toMatchObject({
        agentStatus: {
          state,
          providerSession: { id: 'compact-session' },
          ...(state === 'waiting'
            ? {
                toolName: 'request_user_input',
                interactivePrompt: expect.stringContaining('Which option?')
              }
            : {})
        }
      })
      expect(runtime.getOrchestrationFleetAgentStatusSnapshot()[0].activity).toMatchObject({
        state,
        paneKey: server.getStatusSnapshot()[0].paneKey
      })
      expect(runtime.getExactWorkerProviderSession(handle, 0)).toMatchObject({
        agent: 'codex',
        providerSession: { id: 'compact-session' }
      })
      mocks.callMock.mockImplementation(async (method: string) => {
        if (method === 'worktree.ps') {
          return { ok: true, result: await runtime.getWorktreePs() }
        }
        if (method === 'terminal.wait') {
          return { ok: true, result: { wait: await waitForTranscriptIdle(pane, 2_000) } }
        }
        throw new Error(`Unexpected RPC: ${method}`)
      })
      await main(['worktree', 'ps', '--json'], '/repo/app')
      expect(
        JSON.parse(String(log.mock.calls.at(-1)?.[0])).result.worktrees[0].agents[0]
      ).toMatchObject({ state, prompt: 'Do work' })
      await main(
        ['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--json'],
        '/repo/app'
      )
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject(
        state === 'done'
          ? { result: { wait: { satisfied: true } } }
          : { ok: false, error: { message: 'timeout' } }
      )
      expect(process.exitCode).toBe(state === 'waiting' ? 1 : exitCode)
    } finally {
      stopBridge()
      process.exitCode = exitCode
      runtime.onPtyExit('pty-1', 0)
      server.stop()
    }
  }
)
