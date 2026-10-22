import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWorktreesMock,
  getEffectiveHooksMock,
  getDefaultTabsLaunchMock,
  createSetupRunnerScriptMock,
  shouldRunSetupForCreateMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers } from './worktrees-test-harness'
import { createdWorktreeList } from './worktrees-test-fixtures'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

vi.mock('../automations/workspace-provenance', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAutomationWorkspaceProvenance: ({ request }: { request?: unknown }) =>
    request ? { kind: 'created-by-automation', automationId: 'automation-1' } : undefined,
  finishAutomationWorkspaceProvenanceRequest: () => {},
  releaseAutomationWorkspaceProvenanceRequest: () => {}
}))

const automationProvenanceRequest = {
  automationId: 'automation-1',
  automationRunId: 'run-1',
  dispatchToken: 'token-1',
  createRequestId: 'create-1'
}
const defaultTabs = { tabs: [{ title: 'Dev', command: 'pnpm dev' }], runCommands: true }

describe('automation creates: main provisions setup and default tabs', () => {
  let provision: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const runtime = setupWorktreeHandlers()
    provision = vi.fn().mockResolvedValue({ setupSpawned: true, setupTerminalHandle: 'term-setup' })
    Object.assign(runtime, { provisionManagedWorktreeTerminals: provision })
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockReturnValue({ scripts: { setup: 'pnpm worktree:setup' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)
    getDefaultTabsLaunchMock.mockReturnValue(defaultTabs)
  })

  it('provisions once in main and hands the window nothing to launch', async () => {
    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run',
      automationProvenanceRequest
    })

    expect(result).not.toHaveProperty('setup')
    expect(result).not.toHaveProperty('defaultTabs')
    expect(provision).toHaveBeenCalledOnce()
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/workspace/improve-dashboard',
        setup: expect.objectContaining({
          runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh'
        }),
        defaultTabs,
        hasStartupTerminal: false,
        setupCommandPlatform: 'posix',
        surfaceOwner: false
      }),
      expect.objectContaining({ path: '/workspace/improve-dashboard' })
    )
  })

  // Same pick the window made: the runner's path decides, a bare path falls back to posix.
  it.each([
    { runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.cmd', platform: 'windows' },
    { runnerScriptPath: '/home/me/repo/.git/orca/setup-runner.sh', platform: 'posix' }
  ])(
    'runs a $platform runner with the $platform command',
    async ({ runnerScriptPath, platform }) => {
      createSetupRunnerScriptMock.mockReturnValueOnce({ runnerScriptPath, envVars: {} })

      await handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard',
        setupDecision: 'run',
        automationProvenanceRequest
      })

      expect(provision).toHaveBeenCalledWith(
        expect.objectContaining({ setupCommandPlatform: platform }),
        expect.anything()
      )
    }
  )

  it('leaves a create from the app window to the window', async () => {
    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(result).toMatchObject({ setup: expect.anything(), defaultTabs })
    expect(provision).not.toHaveBeenCalled()
  })
})
