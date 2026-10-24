import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AGENT_RESOLVE_DEFAULT_METHODS } from './agent-resolve-default'
import type * as WorkspaceAgentDetection from '../../../preflight/workspace-agent-detection'

const { detectMock, resolveWorkspaceHostMock } = vi.hoisted(() => ({
  detectMock: vi.fn(),
  resolveWorkspaceHostMock: vi.fn()
}))

vi.mock('../../../preflight/agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectMock,
  refreshShellPathAndDetectAgents: vi.fn()
}))

vi.mock('../../../preflight/workspace-agent-detection', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceAgentDetection>()),
  resolveWorkspaceAgentDetectionHost: resolveWorkspaceHostMock
}))

const WSL_CONTEXT = { projectRuntime: { kind: 'wsl', distro: 'Ubuntu' } }

function dispatcherFor(runtime: Record<string, unknown>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the members each test supplies.
  const stub = { getRuntimeId: () => 'host', ...runtime } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime: stub, methods: AGENT_RESOLVE_DEFAULT_METHODS })
}

function resolveDefault(dispatcher: RpcDispatcher, target: unknown) {
  return dispatcher.dispatch({
    id: 'req-1',
    authToken: 't',
    method: 'agent.resolveDefault',
    params: { target }
  })
}

describe('agent.resolveDefault', () => {
  it('detects agents on the existing workspace’s own execution host', async () => {
    detectMock.mockResolvedValueOnce(['claude', 'omp'])
    const resolveAgentDetectionHost = vi.fn(async () => ({ kind: 'local', context: WSL_CONTEXT }))
    const dispatcher = dispatcherFor({
      getClientSettings: () => ({ defaultTuiAgent: 'omp', disabledTuiAgents: [] }),
      showTerminalWorkspaceLaunchScope: async () => ({ id: 'repo-1::/w', path: '/w' }),
      resolveAgentDetectionHost
    })

    const response = await resolveDefault(dispatcher, { kind: 'existing', worktree: 'path:/w' })

    expect(resolveAgentDetectionHost).toHaveBeenCalledWith('repo-1::/w')
    expect(detectMock).toHaveBeenCalledWith(WSL_CONTEXT)
    expect(response).toMatchObject({ ok: true, result: { agent: 'omp', selection: 'configured' } })
  })

  it('detects agents where the new worktree’s repo is set up, keeping the chosen host', async () => {
    detectMock.mockResolvedValueOnce(['codex'])
    resolveWorkspaceHostMock.mockReturnValueOnce({ kind: 'local', context: WSL_CONTEXT })
    const showRepo = vi.fn(async () => ({
      id: 'repo-1',
      path: '/srv/repo',
      executionHostId: 'local'
    }))
    const dispatcher = dispatcherFor({
      getClientSettings: () => ({ defaultTuiAgent: null, disabledTuiAgents: [] }),
      showRepo,
      requireStore: () => ({})
    })

    const response = await resolveDefault(dispatcher, {
      kind: 'create-worktree',
      repo: 'id:repo-1',
      repoHostId: 'local'
    })

    expect(showRepo).toHaveBeenCalledWith({ selector: 'id:repo-1', hostId: 'local' })
    expect(resolveWorkspaceHostMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ kind: 'worktree', repoId: 'repo-1', path: '/srv/repo' })
    )
    expect(detectMock).toHaveBeenCalledWith(WSL_CONTEXT)
    expect(response).toMatchObject({ ok: true, result: { agent: 'codex', selection: 'automatic' } })
  })
})
