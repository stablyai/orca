import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  OrcaRuntimeService,
  computeWorktreePathMock,
  createSetupRunnerScript,
  electronMocks,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  listWorktrees,
  shouldRunSetupForCreate
} from './orca-runtime-test-mocks.spec'
import { store } from './orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'

describe('host worktree creation while its renderer is unavailable', () => {
  it.each([
    ['git', 'reload', 'host'],
    ['git', 'crash', 'host'],
    ['folder', 'reload', 'host'],
    ['folder', 'crash', 'host'],
    ['git', 'reload', 'all'],
    ['git', 'crash', 'all'],
    ['folder', 'reload', 'all'],
    ['folder', 'crash', 'all']
  ] as const)(
    'provisions %s work after a renderer %s for %s navigation with its notifier retained',
    async (kind, loss, navigation) => {
      const repo = { ...store.getRepo('repo-1')!, kind }
      const runtime = new OrcaRuntimeService({
        ...store,
        getRepos: () => [repo],
        getRepo: (id) => (id === repo.id ? repo : undefined)
      })
      onTestFinished(() => runtime.markGraphUnavailable(1))
      const notifier = createMobileCreateTestNotifier(vi.fn())
      runtime.setNotifier(notifier)
      runtime.setPtyController({
        spawn: vi.fn(),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
      runtime.markGraphReady(1)
      runtime.markRendererReloading(1)
      if (loss === 'crash') {
        runtime.markGraphReloadFailed(1, 'renderer-process-gone')
      }
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
        handle: 'background-terminal',
        worktreeId: 'created-worktree',
        title: null,
        surface: 'background'
      })
      const worktreePath = '/tmp/workspaces/renderer-unavailable'
      computeWorktreePathMock.mockReturnValue(worktreePath)
      ensurePathWithinWorkspaceMock.mockReturnValue(worktreePath)
      vi.mocked(listWorktrees).mockResolvedValue([
        {
          path: worktreePath,
          head: 'abc',
          branch: 'renderer-unavailable',
          isBare: false,
          isMainWorktree: false
        }
      ])
      vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'echo setup' } })
      vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
      vi.mocked(createSetupRunnerScript).mockReturnValue({
        runnerScriptPath: '/tmp/setup-runner.sh',
        envVars: {}
      })
      const result = await runtime.createManagedWorktree({
        repoSelector: `id:${repo.id}`,
        name: 'renderer-unavailable',
        activate: true,
        navigation,
        setupDecision: 'run'
      })
      expect(createTerminal).toHaveBeenCalled()
      expect(
        createTerminal.mock.calls.every(([, options]) => options?.surfaceOwner === false)
      ).toBe(true)
      if (kind === 'git') {
        expect(createTerminal.mock.calls.some(([, options]) => options?.title === 'Setup')).toBe(
          true
        )
        expect(result.setup).toBeUndefined()
      }
    }
  )
})
