// Every runtime create (CLI, agents, phone, paired clients, orchestration) is listed in the host's
// creation registry while it runs, and names its workspace before the host announces it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

const mocks = vi.hoisted(() => ({
  track: vi.fn<(name: string, props: Record<string, unknown>) => void>(),
  probe: vi.fn(),
  createLocal: vi.fn(),
  createFolder: vi.fn(),
  startTerminals: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: mocks.track, isTelemetryEnabled: () => true }))
vi.mock('../git/create-event-repo-probe', () => ({ probeCreateEventRepoFacts: mocks.probe }))
vi.mock('./runtime-local-worktree-create', () => ({
  createRuntimeLocalManagedWorktree: mocks.createLocal
}))
vi.mock('./runtime-folder-worktree-create', () => ({
  createRuntimeFolderWorktree: mocks.createFolder
}))
vi.mock('./runtime-local-worktree-terminal-startup', () => ({
  startRuntimeLocalWorktreeTerminals: mocks.startTerminals
}))
vi.mock('./runtime-local-worktree-setup', () => ({
  prepareRuntimeLocalWorktreeSetup: vi.fn(async () => ({
    effectiveDecision: 'skip',
    hookFound: false,
    shouldRunSetup: false,
    didStartInProcessSetupHook: false
  }))
}))
vi.mock('../ipc/filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: vi.fn(),
  invalidateAuthorizedRootsCacheForRepo: vi.fn()
}))

import { OrcaRuntimeService } from './orca-runtime'

const gitRepo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  kind: 'git'
}
const worktree = { id: 'wt-1', path: '/worktrees/app', branch: 'app', repoId: gitRepo.id }

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

function makeRuntime(repo: Record<string, unknown> = gitRepo): OrcaRuntimeService {
  const store = {
    getSettings: () => ({ disabledTuiAgents: ['codex'], workspaceDir: '/worktrees' }),
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

type LocalCreateArgs = { onWorktreeMetadataPersisted: (created: { id: string }) => unknown }

function creationsOf(runtime: OrcaRuntimeService): Record<string, unknown> {
  if (!runtime.workspaceCreations) {
    throw new Error('the switch is mocked on')
  }
  return runtime.workspaceCreations.snapshot().creations
}

describe('runtime creation registry', () => {
  beforeEach(() => {
    mocks.track.mockReset()
    mocks.probe.mockReset().mockResolvedValue({})
    mocks.startTerminals.mockReset().mockResolvedValue({})
  })

  it('lists a phone create under its retry key, named before the workspace is announced', async () => {
    const runtime = makeRuntime()
    const seen: Record<string, unknown>[] = []
    const record = (): void => {
      seen.push(creationsOf(runtime))
    }
    mocks.createLocal.mockReset().mockImplementation(async (args: LocalCreateArgs) => {
      record()
      args.onWorktreeMetadataPersisted(worktree)
      return {
        worktree,
        worktreePath: worktree.path,
        created: { path: worktree.path, head: 'abc', branch: 'app' },
        addResult: {},
        metadataResult: { lineage: null, workspaceLineage: null, warnings: [] }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: notifyWorktreesChanged exists on the service; the cast only exposes the protected member to the spy.
    const internals = runtime as unknown as { notifyWorktreesChanged: (repoId: string) => void }
    vi.spyOn(internals, 'notifyWorktreesChanged').mockImplementation(record)
    const onWorkspaceCreated = vi.fn()

    await runtime.createManagedWorktree({
      repoSelector: 'repo-1',
      name: 'app',
      creationId: 'phone-op-1',
      onWorkspaceCreated
    })

    expect(seen).toEqual([
      { 'phone-op-1': { repoId: 'repo-1' } },
      { 'phone-op-1': { repoId: 'repo-1', worktreeId: 'wt-1' } }
    ])
    expect(onWorkspaceCreated).toHaveBeenCalledWith('wt-1')
    expect(creationsOf(runtime)).toEqual({})
  })

  it('drops a failed create', async () => {
    const runtime = makeRuntime()
    mocks.createLocal.mockReset().mockRejectedValue(new Error('fatal: could not create'))

    await expect(
      runtime.createManagedWorktree({ repoSelector: 'repo-1', name: 'app' })
    ).rejects.toThrow('could not create')
    expect(creationsOf(runtime)).toEqual({})
  })

  it('lists a folder workspace create too', async () => {
    const runtime = makeRuntime({ id: 'folder', path: '/notes', kind: 'folder' })
    let during: Record<string, unknown> = {}
    mocks.createFolder.mockReset().mockImplementation(async () => {
      during = creationsOf(runtime)
      return { worktree: { id: 'folder::/notes' } }
    })

    await runtime.createManagedWorktree({ repoSelector: 'folder', name: 'notes' })

    expect(Object.values(during)).toEqual([{ repoId: 'folder' }])
    expect(creationsOf(runtime)).toEqual({})
  })
})
