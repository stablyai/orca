// Re-arming the prepared-checkout pool is a full `reset --hard`. Firing it before the create's
// terminals are launched puts that checkout in front of the startup agent's first git reads.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

const calls = vi.hoisted(() => ({ order: new Array<string>() }))

const createLocalMock = vi.hoisted(() => vi.fn())
vi.mock('./runtime-local-worktree-create', () => ({
  createRuntimeLocalManagedWorktree: createLocalMock
}))

const startTerminalsMock = vi.hoisted(() => vi.fn())
vi.mock('./runtime-local-worktree-terminal-startup', () => ({
  startRuntimeLocalWorktreeTerminals: startTerminalsMock
}))

vi.mock('./runtime-local-worktree-setup', () => ({
  prepareRuntimeLocalWorktreeSetup: vi.fn(async () => ({
    setup: undefined,
    defaultTabs: undefined,
    warning: undefined,
    effectiveDecision: 'skip',
    hookFound: false,
    shouldRunSetup: false,
    didStartInProcessSetupHook: false
  }))
}))

vi.mock('../ipc/filesystem-auth', () => ({ invalidateAuthorizedRootsCache: vi.fn() }))

import { OrcaRuntimeService } from './orca-runtime'

const repo = { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: 'blue', kind: 'git' }

const worktree = { id: 'wt-1', path: '/worktrees/app', branch: 'app', repoId: repo.id }

type RuntimeInternals = {
  resolveRepoSelector: (selector: string) => Promise<unknown>
  resolveLineageForWorktreeCreate: (input: unknown) => Promise<unknown>
  recordCreatedWorktreeLineage: (created: unknown, resolution: unknown) => unknown
  getLocalGitExecutionOptionArgs: (repo: unknown) => unknown[]
  getHostedReviewExecutionOptions: (repo: unknown) => unknown
  invalidateResolvedWorktreeCache: () => void
  invalidateWorktreeScanCacheForRepo: (repoId: string) => void
  notifyWorktreesChanged: (repoId: string) => void
  emitWorktreeLifecycle: (event: unknown) => void
}

function makeRuntime(): OrcaRuntimeService {
  const store = {
    getSettings: () => ({ disabledTuiAgents: [], workspaceDir: '/worktrees' }),
    getProjectHostSetups: () => []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every store method this create path reaches is supplied above.
  const runtime = new OrcaRuntimeService(store as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the named members all exist on the service; the cast only exposes non-public ones to the spies.
  const internals = runtime as unknown as RuntimeInternals
  vi.spyOn(internals, 'resolveRepoSelector').mockResolvedValue(repo)
  vi.spyOn(internals, 'resolveLineageForWorktreeCreate').mockResolvedValue(null)
  vi.spyOn(internals, 'recordCreatedWorktreeLineage').mockReturnValue({
    lineage: null,
    workspaceLineage: null,
    warnings: []
  })
  vi.spyOn(internals, 'getLocalGitExecutionOptionArgs').mockReturnValue([{}])
  vi.spyOn(internals, 'getHostedReviewExecutionOptions').mockReturnValue(undefined)
  vi.spyOn(internals, 'invalidateResolvedWorktreeCache').mockReturnValue(undefined)
  vi.spyOn(internals, 'invalidateWorktreeScanCacheForRepo').mockReturnValue(undefined)
  vi.spyOn(internals, 'notifyWorktreesChanged').mockReturnValue(undefined)
  vi.spyOn(internals, 'emitWorktreeLifecycle').mockReturnValue(undefined)
  return runtime
}

describe('runtime local create prepared-pool re-arm ordering', () => {
  beforeEach(() => {
    calls.order = []
    createLocalMock.mockReset()
    startTerminalsMock.mockReset()
    createLocalMock.mockImplementation(async () => ({
      worktree,
      worktreePath: worktree.path,
      includeCopyWarning: undefined,
      created: { path: worktree.path, head: 'abc', branch: 'app' },
      addResult: {},
      metadataResult: { lineage: null, workspaceLineage: null, warnings: [] },
      rearmPreparation: () => calls.order.push('rearm')
    }))
    startTerminalsMock.mockImplementation(async () => {
      calls.order.push('terminals')
      return {
        warning: undefined,
        returnedSetup: undefined,
        didSpawnSetup: false,
        didSpawnStartup: false,
        setupTerminalHandle: undefined,
        startupTerminalHandle: undefined,
        startupTerminalTabId: undefined,
        startupTerminalPaneKey: undefined,
        startupTerminalPtyId: undefined
      }
    })
  })

  it('arms the pool only after the startup terminals are launched', async () => {
    const runtime = makeRuntime()

    await runtime.createManagedWorktree({ repoSelector: 'repo-1', name: 'app' })

    expect(startTerminalsMock).toHaveBeenCalledOnce()
    expect(calls.order).toEqual(['terminals', 'rearm'])
  })

  it('still arms the pool when terminal launch fails', async () => {
    startTerminalsMock.mockRejectedValue(new Error('spawn failed'))
    const runtime = makeRuntime()

    await expect(
      runtime.createManagedWorktree({ repoSelector: 'repo-1', name: 'app' })
    ).rejects.toThrow('spawn failed')

    // The prepared checkout was consumed before the failure, so the replacement is still owed.
    expect(calls.order).toEqual(['rearm'])
  })
})
