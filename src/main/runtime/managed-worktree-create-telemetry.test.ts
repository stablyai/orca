// Runtime creates (CLI, agents, phone, paired clients, orchestration) reuse prepared checkouts
// like the app's own creates, so they must send the same create events, exactly once each.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import type { WorktreeCreateTimingRecorder } from '../worktree-create-timing'
import type { PreparationRearmHolder } from '../worktree-create-preparation'
import {
  _resetWorktreeCreateConcurrencyForTests,
  beginPreparationWork,
  type PreparationWork
} from '../worktree-create-concurrency'

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
  vi.spyOn(internals, 'resolveLineageForWorktreeCreate').mockResolvedValue({
    kind: 'none',
    warnings: []
  })
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

type LocalCreateArgs = { timing: WorktreeCreateTimingRecorder; rearm: PreparationRearmHolder }

function events(name: string): Record<string, unknown>[] {
  return mocks.track.mock.calls.filter(([event]) => event === name).map(([, props]) => props)
}

function localCreateResult() {
  return {
    worktree,
    worktreePath: worktree.path,
    created: { path: worktree.path, head: 'abc', branch: 'app' },
    addResult: {},
    metadataResult: { lineage: null, workspaceLineage: null, warnings: [] }
  }
}

describe('runtime create events', () => {
  beforeEach(() => {
    mocks.track.mockReset()
    mocks.probe.mockReset().mockResolvedValue({ postCheckoutHook: 'absent', indexEntryCount: 2048 })
    mocks.createFolder.mockReset().mockResolvedValue({ worktree: { id: 'folder-1' } })
    mocks.startTerminals.mockReset().mockResolvedValue({})
    mocks.createLocal.mockReset().mockImplementation(async ({ timing }: LocalCreateArgs) => {
      timing.recordExecutionHost('local')
      await timing.time('git_worktree_add', async () => {
        timing.recordPreparedCheckout({
          status: 'hit',
          reset: 'none',
          origin: 'prefetch',
          buildMs: 9_000,
          idleMs: 120
        })
      })
      return localCreateResult()
    })
  })

  afterEach(() => {
    _resetWorktreeCreateConcurrencyForTests()
  })

  it('sends one workspace_created with the runtime entry point and the timing fields', async () => {
    await makeRuntime().createManagedWorktree({
      repoSelector: 'repo-1',
      name: 'app',
      baseBranch: 'origin/main',
      telemetrySource: 'sidebar'
    })
    await vi.waitFor(() => expect(events('workspace_created')).toHaveLength(1))

    expect(events('workspace_created')[0]).toMatchObject({
      source: 'sidebar',
      from_existing_branch: true,
      create_entry_point: 'runtime',
      execution_host: 'local',
      prepared_checkout: 'hit',
      prepared_checkout_reset: 'none',
      prepared_checkout_origin: 'prefetch',
      concurrent_creates: 0,
      concurrent_preparations: 0,
      repo_file_count_bucket: '1k-10k',
      post_checkout_hook: 'absent'
    })
    expect(typeof events('workspace_created')[0].git_worktree_add_ms).toBe('number')
    expect(mocks.probe).toHaveBeenCalledWith('/repo')
    expect(events('workspace_create_failed')).toHaveLength(0)
  })

  it('sends one workspace_create_failed naming the phase the create died in', async () => {
    mocks.createLocal.mockImplementation(async ({ timing }: LocalCreateArgs) =>
      timing.time('git_worktree_add', async () => {
        throw new Error('fatal: could not create work tree dir /worktrees/app')
      })
    )

    await expect(
      makeRuntime().createManagedWorktree({ repoSelector: 'repo-1', name: 'app' })
    ).rejects.toThrow('could not create work tree')

    expect(events('workspace_create_failed')).toEqual([
      expect.objectContaining({
        source: 'unknown',
        failed_phase: 'git_worktree_add',
        create_entry_point: 'runtime'
      })
    ])
    expect(JSON.stringify(events('workspace_create_failed'))).not.toMatch(/worktrees|fatal/)
    expect(events('workspace_created')).toHaveLength(0)
  })

  it('counts preparation work running during the create but not the re-arm the create starts', async () => {
    let competing: PreparationWork | undefined
    mocks.createLocal.mockImplementation(async ({ rearm }: LocalCreateArgs) => {
      competing = beginPreparationWork()
      // The re-arm starts its build synchronously when fired, after the create's last step.
      rearm.fire = () => {
        beginPreparationWork()
        beginPreparationWork()
      }
      return localCreateResult()
    })

    await makeRuntime().createManagedWorktree({ repoSelector: 'repo-1', name: 'app' })
    competing?.end()
    await vi.waitFor(() => expect(events('workspace_created')).toHaveLength(1))

    expect(events('workspace_created')[0]).toMatchObject({ concurrent_preparations: 1 })
  })

  it('still returns the create when sending its event throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.track.mockImplementation(() => {
      throw new Error('telemetry broke')
    })

    await expect(
      makeRuntime().createManagedWorktree({ repoSelector: 'repo-1', name: 'app' })
    ).resolves.toMatchObject({ worktree: { id: 'wt-1' } })
    await vi.waitFor(() => expect(mocks.track).toHaveBeenCalledOnce())
  })

  it('still rejects with the create error when sending the failure event throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.track.mockImplementation(() => {
      throw new Error('telemetry broke')
    })
    mocks.createLocal.mockRejectedValue(new Error('fatal: could not create work tree'))

    await expect(
      makeRuntime().createManagedWorktree({ repoSelector: 'repo-1', name: 'app' })
    ).rejects.toThrow('could not create work tree')
    expect(mocks.track).toHaveBeenCalledOnce()
  })

  it('carries the SSH create timing the runtime hands to the remote create', async () => {
    const runtime = makeRuntime({
      id: 'repo-remote',
      path: '/srv/app',
      kind: 'git',
      executionHostId: 'ssh:remote-1'
    })
    const remoteCreate = vi.fn(
      async (_repo: unknown, args: { timing?: WorktreeCreateTimingRecorder }) => {
        // Stands in for createRemoteWorktree, which records into the recorder it is given.
        args.timing?.recordExecutionHost('ssh')
        await args.timing?.time('git_worktree_add', async () => {})
        return { worktree }
      }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createManagedRemoteWorktree exists on the service; the cast only exposes the protected member to the spy.
    const internals = runtime as unknown as { createManagedRemoteWorktree: typeof remoteCreate }
    vi.spyOn(internals, 'createManagedRemoteWorktree').mockImplementation(remoteCreate)

    await runtime.createManagedWorktree({ repoSelector: 'repo-remote', name: 'app' })
    await vi.waitFor(() => expect(events('workspace_created')).toHaveLength(1))

    expect(remoteCreate.mock.calls[0]?.[1].timing).toBeDefined()
    expect(events('workspace_created')[0]).toMatchObject({
      create_entry_point: 'runtime',
      execution_host: 'ssh'
    })
    expect(typeof events('workspace_created')[0].git_worktree_add_ms).toBe('number')
    // SSH would need a remote round trip, so the repo is not probed.
    expect(mocks.probe).not.toHaveBeenCalled()
  })

  it('sends nothing for a folder workspace, as before', async () => {
    await makeRuntime({ id: 'folder', path: '/notes', kind: 'folder' }).createManagedWorktree({
      repoSelector: 'folder',
      name: 'notes'
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(mocks.track).not.toHaveBeenCalled()
  })

  it('sends nothing when the request is rejected before any create starts', async () => {
    await expect(
      makeRuntime().createManagedWorktree({
        repoSelector: 'repo-1',
        name: 'app',
        startupAgent: 'codex'
      })
    ).rejects.toThrow('Selected agent is disabled')
    expect(mocks.createLocal).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
  })
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(full)
    }
    return entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name) ? [full] : []
  })
}

describe('one event per create', () => {
  const mainDir = path.resolve(__dirname, '..')
  const relative = (file: string): string => path.relative(mainDir, file).split(path.sep).join('/')

  it('sends the create events only from the shared sender, besides the SSH root adopt', () => {
    const senders = sourceFiles(mainDir)
      .filter((file) =>
        /track\(\s*'workspace_(created|create_failed)'/.test(readFileSync(file, 'utf8'))
      )
      .map(relative)
      .sort()
    expect(senders).toEqual([
      'ipc/worktrees/create/register-worktree-create-handlers.ts',
      'workspace-create-telemetry.ts'
    ])
    const handler = readFileSync(
      path.join(mainDir, 'ipc/worktrees/create/register-worktree-create-handlers.ts'),
      'utf8'
    )
    // The remaining direct sends there belong to the root adopt, which no other entry point runs.
    expect(handler.match(/track\(\s*'workspace_(created|create_failed)'/g)).toHaveLength(2)
  })

  it('keeps the app and runtime entry points from running each other', () => {
    const handler = readFileSync(
      path.join(mainDir, 'ipc/worktrees/create/register-worktree-create-handlers.ts'),
      'utf8'
    )
    expect(handler).not.toMatch(/createManagedWorktree/)
    const runtimeImportsHandler = sourceFiles(path.join(mainDir, 'runtime')).filter((file) =>
      /register-worktree-create-handlers|ipcMain\.emit|['"]worktrees:create['"]/.test(
        readFileSync(file, 'utf8')
      )
    )
    expect(runtimeImportsHandler.map(relative)).toEqual([])
  })
})
