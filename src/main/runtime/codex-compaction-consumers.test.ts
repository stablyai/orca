import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { buildBody, postHookEvent } from '../agent-hooks/server.test-fixtures'
import { createTranscriptPane, waitForTranscriptIdle } from './agent-transcript-pane-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import type { ResolvedWorktreeSnapshot } from './runtime-resolved-worktree-cache'
import { storeWorktreeMeta } from './runtime-store-partial-fixture'
import { codexCompactionSequence } from '../../shared/agent-hook-listener-test-harness'
import { buildWorktree } from '../../cli/test-fixtures'

const mocks = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp')
}))
vi.mock('../../cli/runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('../../cli/index-test-harness.js')
  return createRuntimeClientModuleMock(mocks)
})
vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
import { main } from '../../cli/index'

class CompactionRuntime extends OrcaRuntimeService {
  protected override async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
    const { git } = buildWorktree('/repo/app', 'feature')
    return {
      worktrees: [
        {
          ...storeWorktreeMeta(),
          ...git,
          id: 'wt-1',
          repoId: 'repo-1',
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null,
          git
        }
      ],
      platformByRepoId: new Map()
    }
  }
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
      },
      CompactionRuntime
    )
    const { runtime, handle } = pane
    vi.stubEnv('ORCA_PAIRING_CODE', '')
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exitCode = process.exitCode
    try {
      for (const payload of codexCompactionSequence(state)) {
        const body = buildBody(payload, { launchToken: 'transcript-launch' })
        expect((await postHookEvent(server, body, '/hook/codex')).status).toBe(204)
      }
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
      process.exitCode = exitCode
      runtime.onPtyExit('pty-1', 0)
      server.stop()
    }
  }
)
