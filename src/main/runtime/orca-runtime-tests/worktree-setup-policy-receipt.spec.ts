import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { OrcaRuntimeService as Runtime } from '../orca-runtime'
import {
  OrcaRuntimeService,
  computeWorktreePathMock,
  createSetupRunnerScript,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  listWorktrees,
  loadHooks,
  runHook,
  shouldRunSetupForCreate
} from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'
import { agentLaunchWorkspaceFactory } from '../rpc/methods/agent-launch-worktree-creation'

const WORKTREE_PATH = '/tmp/workspaces/required-setup-receipt'

function requiredSetupRuntime(source: 'repo' | 'project' | 'parallel'): Runtime {
  const repo = store.getRepo('repo-1')
  if (!repo) {
    throw new Error('Missing fixture repository')
  }
  const configured: Repo = {
    ...repo,
    hookSettings: {
      mode: 'auto',
      setupRunPolicy: 'run-by-default',
      setupAgentStartupPolicy: source === 'repo' ? 'wait-for-setup' : 'start-immediately',
      scripts: { setup: '', archive: '' }
    }
  }
  vi.mocked(loadHooks).mockReturnValue({
    scripts: { setup: 'prepare-project' },
    ...(source === 'project' ? { setupAgentStartupPolicy: 'wait-for-setup' as const } : {})
  })
  vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'prepare-project' } })
  vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
  computeWorktreePathMock.mockReturnValue(WORKTREE_PATH)
  ensurePathWithinWorkspaceMock.mockReturnValue(WORKTREE_PATH)
  vi.mocked(listWorktrees).mockResolvedValue([
    {
      path: WORKTREE_PATH,
      head: 'def',
      branch: 'required-setup-receipt',
      isBare: false,
      isMainWorktree: false
    }
  ])
  return new OrcaRuntimeService({
    ...store,
    getRepos: () => [configured],
    getRepo: (id: string) => (id === configured.id ? configured : undefined)
  })
}

const create = (runtime: Runtime) =>
  runtime.createManagedWorktree({
    repoSelector: 'id:repo-1',
    name: 'required-setup-receipt',
    setupDecision: 'run',
    createdWithAgent: 'codex',
    promisedAgentChat: true,
    observeSetupCompletion: true,
    awaitTerminalProvisioning: true
  })

describe('required setup policy in the real worktree creation receipt', () => {
  it.each([false, true])(
    'blocks the requested terminal agent after runner failure (activate=%s)',
    async (activate) => {
      const runtime = requiredSetupRuntime('repo')
      const createTerminal = vi.spyOn(runtime, 'createTerminal')
      runtime.setPtyController({
        spawn: vi.fn(async () => ({ id: 'setup-failure-shell' })),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      vi.mocked(createSetupRunnerScript).mockImplementation(() => {
        throw new Error('runner write failed')
      })

      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'required-setup-receipt',
        setupDecision: 'run',
        startupAgent: 'claude',
        activate,
        observeSetupCompletion: true,
        awaitTerminalProvisioning: true
      })

      expect(result.setupReceipt).toMatchObject({
        startupPolicy: 'wait-for-setup',
        state: 'spawn_failed'
      })
      expect(result.startupTerminal).toBeUndefined()
      expect(createTerminal).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ launchAgent: 'claude' }),
        expect.anything()
      )
    }
  )

  it.each(['skip', 'parallel'] as const)(
    'preserves requested terminal startup with explicit %s setup behavior',
    async (mode) => {
      const runtime = requiredSetupRuntime(mode === 'skip' ? 'repo' : 'parallel')
      runtime.setPtyController({
        spawn: vi.fn(async () => ({ id: 'permitted-agent-pty' })),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      if (mode === 'skip') {
        vi.mocked(shouldRunSetupForCreate).mockReturnValue(false)
      }
      vi.mocked(createSetupRunnerScript).mockImplementation(() => {
        throw new Error('runner write failed')
      })

      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'required-setup-receipt',
        setupDecision: mode === 'skip' ? 'skip' : 'run',
        startupAgent: 'claude',
        observeSetupCompletion: true,
        awaitTerminalProvisioning: true
      })

      expect(result.startupTerminal).toMatchObject({ spawned: true })
      if (mode === 'skip') {
        expect(createSetupRunnerScript).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['repo', 'project'] as const)(
    'keeps %s policy when generating the runner fails',
    async (source) => {
      const runtime = requiredSetupRuntime(source)
      runtime.setPtyController({
        spawn: vi.fn(async () => ({ id: 'unused-setup-pty' })),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      vi.mocked(createSetupRunnerScript).mockImplementation(() => {
        throw new Error('runner write failed')
      })

      const result = await create(runtime)

      expect(result.setupReceipt).toMatchObject({
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'spawn_failed'
      })
      expect(result.setupReceipt?.terminalHandle).toBeUndefined()
      expect(result.startupTerminal).toBeUndefined()
    }
  )

  it.each(['failed', 'unfinished'] as const)(
    'keeps required policy for an unobserved %s in-process hook',
    async (outcome) => {
      const runtime = requiredSetupRuntime('project')
      if (outcome === 'failed') {
        vi.mocked(runHook).mockResolvedValue({ success: false, output: 'setup failed' })
      } else {
        vi.mocked(runHook).mockReturnValue(new Promise(() => {}))
      }

      const result = await create(runtime)

      expect(createSetupRunnerScript).not.toHaveBeenCalled()
      expect(runHook).toHaveBeenCalled()
      expect(result.setupReceipt).toMatchObject({
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running'
      })
      expect(result.setupReceipt?.terminalHandle).toBeUndefined()
      expect(result.startupTerminal).toBeUndefined()
    }
  )

  it.each(['runner-failure', 'unobserved-hook'] as const)(
    'refuses structured launch using the actual %s receipt',
    async (failure) => {
      const runtime = requiredSetupRuntime('repo')
      if (failure === 'runner-failure') {
        runtime.setPtyController({
          spawn: vi.fn(async () => ({ id: 'unused-gated-setup-pty' })),
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => null
        })
        vi.mocked(createSetupRunnerScript).mockImplementation(() => {
          throw new Error('runner write failed')
        })
      } else {
        vi.mocked(runHook).mockReturnValue(new Promise(() => {}))
      }

      await expect(
        agentLaunchWorkspaceFactory({ runtime }, 'codex').createWorktree({
          create: { repo: 'id:repo-1', name: 'required-setup-receipt', setupDecision: 'run' },
          startupAgent: undefined,
          promisedAgentChat: true
        })
      ).rejects.toMatchObject({ code: 'agent_setup_unconfirmed' })
    }
  )
})
