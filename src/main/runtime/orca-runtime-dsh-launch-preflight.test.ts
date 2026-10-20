import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { prepareDshModelStartupInputs } from '../dsh/dsh-model-startup-plan'
import type * as AgentLaunchScopeRuntime from './agent-launch-scope-runtime'
import { resolveAgentLaunchRuntime } from './agent-launch-scope-runtime'
import { OrcaRuntimeWithGetTerminalInteractiveWait } from './terminal/wait/terminal-interactive-wait'

vi.mock('../dsh/dsh-model-startup-plan', () => ({
  prepareDshModelStartupInputs: vi.fn(async ({ inputs }) => inputs)
}))
vi.mock('./agent-launch-scope-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentLaunchScopeRuntime>()
  return {
    ...actual,
    resolveAgentLaunchRuntime: vi.fn(() => ({ platform: process.platform }))
  }
})

const repo: Repo = {
  id: 'repo-exact',
  path: '/repo-exact',
  displayName: 'Exact worker repository',
  badgeColor: 'blue',
  addedAt: 1
}

function fixture(selectedRepo = repo, workspaceDir = '/worktrees') {
  const workspace = {
    id: 'worktree-exact',
    path: '/worktrees/exact',
    repo: selectedRepo,
    connectionId: null,
    folderWorkspace: null
  }
  const store = {
    getSettings: () => ({
      nestWorkspaces: false,
      workspaceDir,
      agentCmdOverrides: { dsh: '/native/dsh-tui' },
      agentDefaultEnv: { dsh: { DSH_HOME: '/worker-profile' } }
    })
  }
  const host = {
    requireStore: () => store,
    resolveRepoSelector: vi.fn(async () => selectedRepo),
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => workspace)
  }
  const preflight = (target: {
    repo?: string
    worktree?: string
    model: string
    effort?: string
  }) =>
    OrcaRuntimeWithGetTerminalInteractiveWait.prototype.assertOrchestrationDshModelLaunchSupport.call(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: shipping method reads only the explicitly stubbed host methods above.
      host as never,
      target
    )
  return { preflight, host, workspace, store }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DSH runtime launch preflight target', () => {
  it('uses the exact existing worktree and its configured environment', async () => {
    const { preflight, host, workspace, store } = fixture()
    await preflight({ worktree: 'worktree-exact', model: 'ark/kimi3', effort: 'native-high' })
    expect(host.resolveTerminalWorkspaceLaunchScope).toHaveBeenCalledWith('worktree-exact')
    expect(host.resolveRepoSelector).not.toHaveBeenCalled()
    expect(resolveAgentLaunchRuntime).toHaveBeenCalledWith(store, workspace, undefined, 'dsh')
    expect(prepareDshModelStartupInputs).toHaveBeenCalledWith({
      cwd: '/worktrees/exact',
      isWsl: false,
      inputs: expect.objectContaining({
        agent: 'dsh',
        agentEnv: { DSH_HOME: '/worker-profile' },
        sessionOptions: { model: 'ark/kimi3', effort: 'native-high' }
      })
    })
  })

  it('uses the configured WSL worktree placement instead of the repository filesystem', async () => {
    const wslRoot = '\\\\wsl$\\Ubuntu\\home\\worker\\worktrees'
    const { preflight, host } = fixture({ ...repo, path: 'C:\\repo-exact' }, wslRoot)
    await preflight({ repo: 'repo-exact', model: 'ark/kimi3' })
    expect(host.resolveRepoSelector).toHaveBeenCalledWith('repo-exact')
    expect(host.resolveTerminalWorkspaceLaunchScope).not.toHaveBeenCalled()
    expect(prepareDshModelStartupInputs).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: wslRoot, isWsl: true })
    )
  })

  it.each([{ connectionId: 'ssh-worker' }, { executionHostId: 'runtime:another-host' as const }])(
    'never probes the client CLI for foreign execution scope %j',
    async (foreign) => {
      const { preflight } = fixture({ ...repo, ...foreign })
      await expect(preflight({ repo: 'repo-exact', model: 'ark/kimi3' })).rejects.toMatchObject({
        code: 'capability_unsupported'
      })
      expect(resolveAgentLaunchRuntime).not.toHaveBeenCalled()
      expect(prepareDshModelStartupInputs).not.toHaveBeenCalled()
    }
  )
})
