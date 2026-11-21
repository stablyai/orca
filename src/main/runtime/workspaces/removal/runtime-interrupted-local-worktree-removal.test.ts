import type { Repo } from '../../../../shared/repository/repo-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { WorktreeRemovalRecord } from '../../../workspaces/removal/worktree-removal-records'
import { installRealWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { getProjectHostSetupWorktreeMeta } from '../../../../shared/project/host-setup/project-host-setup-lookup'

import { removeTree } from '../../../../shared/file-write/windows-transient-lock-removal'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { Store } from '../../../persistence/loading-store/store'
import type * as HostTreeRemoval from '../../../filesystem/host-tree-removal'
import { removeHostTree } from '../../../filesystem/host-tree-removal'
import type * as RemovalTable from '../../../workspaces/removal/worktree-removal-table'
import { worktreeCheckoutExists } from '../../../workspaces/removal/worktree-removal-table'

import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import '../../../git/worktrees/catalog/worktree-listing'
import '../../../git/worktrees/catalog/worktree-path-comparison'
import {
  acquireWatcherRemovalGate,
  beginTerminalInstall,
  beginWatcherInstall
} from '../../../workspaces/removal/watcher-removal-gate'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  resumeInterruptedWorktreeRemovals,
  waitForPendingWorktreeRemoval
} from '../../../workspaces/removal/worktree-background-removal'

import {
  readWorktreeRemovalRecords,
  writeWorktreeRemovalRecords
} from '../../../workspaces/removal/worktree-removal-records'

import { interruptedLocalWorktreeRemovalJob } from './runtime-interrupted-local-worktree-removal'

vi.mock('../../../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: vi.fn(() => ({}))
}))
vi.mock('../../../filesystem/host-tree-removal', async (importOriginal) => {
  const actual = await importOriginal<typeof HostTreeRemoval>()
  return { ...actual, removeHostTree: vi.fn(actual.removeHostTree) }
})

vi.mock('../../../workspaces/removal/worktree-removal-table', async (importOriginal) => {
  const actual = await importOriginal<typeof RemovalTable>()
  return { ...actual, worktreeCheckoutExists: vi.fn(actual.worktreeCheckoutExists) }
})

const execFileAsync = promisify(execFile)

let scratchDir = ''
let recordsDir = ''
let repoPath = ''
let worktreePath = ''
let repo: Repo
let pushTarget: GitPushTarget | undefined

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

// Parse Git paths: Windows output uses forward slashes unlike native joins.

beforeEach(async () => {
  pushTarget = undefined
  vi.mocked(getLocalProjectWorktreeGitOptions).mockReturnValue({})
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/....
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-interrupted-removal-')))
  recordsDir = join(scratchDir, 'profile')
  repoPath = join(scratchDir, 'repo')
  worktreePath = join(scratchDir, 'workspaces', 'feature')
  await mkdir(recordsDir, { recursive: true })
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'])
  await git(['config', 'user.email', 'removal@example.invalid'])
  await git(['config', 'user.name', 'Worktree Removal'])
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'seed'])
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'])
  repo = { id: 'repo-1', path: repoPath, displayName: 'repo', badgeColor: '', addedAt: 0 }
})

afterEach(async () => {
  _resetPendingWorktreeRemovalsForTests()
  vi.restoreAllMocks()
  vi.mocked(removeHostTree).mockClear()
  await removeTree(scratchDir)
})

type FinishOutcome =
  | ({ status: 'removed' } & RemoveWorktreeResult)
  | { status: 'failed'; error: string }

async function finishAfterRestart(
  options: {
    repoGone?: boolean
    repoRows?: Repo[]
    branch?: string
    head?: string
    force?: boolean
    deleteBranch?: boolean
    stopPtys?: () => Promise<void>
    /** A cleanup removal: bound to the reviewed instance and its checkout proof. */
    reviewed?: Pick<WorktreeRemovalRecord, 'expectedInstanceId' | 'expectedCheckoutIdentity'>
  } = {}
): Promise<{
  outcome: FinishOutcome
  purged: string[]
  remember: ReturnType<typeof vi.fn>
  records: WorktreeRemovalRecord[]
}> {
  const record: WorktreeRemovalRecord = {
    worktreeId: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repoPath,
    worktreePath,
    branch: options.branch ?? 'feature',
    head: options.head ?? (await git(['rev-parse', 'feature'])).trim(),
    deleteBranch: options.deleteBranch ?? true,
    force: options.force ?? false,
    requestedAt: 1,
    ...options.reviewed
  }
  await writeWorktreeRemovalRecords(recordsDir, () => [record])
  await loadWorktreeRemovalRecords(recordsDir)
  // A request that joins before the finish starts gets the finish's result.
  const joined = waitForPendingWorktreeRemoval(record.worktreeId)
  expect(joined).toBeDefined()
  // Session restore runs before the resume: nothing may open a handle in the half-deleted checkout.
  expect(() => beginTerminalInstall(worktreePath)).toThrow(/being removed/)
  expect(() => beginWatcherInstall(worktreePath)).toThrow(/being removed/)

  const purged: string[] = []
  const remember = vi.fn()
  const host = removalHost(options.repoGone, options.stopPtys)
  if (options.repoRows) {
    const rows = options.repoRows
    host.store.getRepos = () => rows
    host.store.getRepo = (id) => rows.find((row) => row.id === id)
  }
  host.purge = ({ worktreeId }) => {
    purged.push(worktreeId)
  }
  host.preservedBranchCleanup.remember = remember
  resumeInterruptedWorktreeRemovals((interrupted) =>
    interruptedLocalWorktreeRemovalJob(interrupted, host)
  )
  const outcome: FinishOutcome = await joined!.then(
    (result) => ({ status: 'removed' as const, ...result }),
    (error: unknown) => ({ status: 'failed' as const, error: String(error) })
  )
  await _settlePendingWorktreeRemovalsForTests()
  const records = await readWorktreeRemovalRecords(recordsDir)
  expect(waitForPendingWorktreeRemoval(record.worktreeId)).toBeUndefined()
  // Released on every outcome, including a finish that ended before taking its own gate.
  beginTerminalInstall(worktreePath)()
  return { outcome, purged, remember, records }
}

function removalHost(
  repoGone = false,
  stopPtys = async () => {},
  teardown = () => {}
): Parameters<typeof interruptedLocalWorktreeRemovalJob>[1] & { store: Store } {
  const store = {
    getRepo: (id: string) => (id === repo.id && !repoGone ? repo : undefined),
    getRepos: () => (repoGone ? [] : [repo]),
    getWorktreeMeta: () => ({
      ...getProjectHostSetupWorktreeMeta([], repo),
      instanceId: 'removal-fixture',
      orcaCreatedAt: 1,
      orcaCreationSource: 'runtime',
      pushTarget
    }),
    getWorktreeMetaForHost: () => store.getWorktreeMeta(),
    getSettings: () => getDefaultSettings(scratchDir),
    getProjectHostSetups: () => [],
    getAllWorktreeMeta: () => ({})
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the removal/listing paths read only the supplied store methods; the fixture owns all process/session services.
    store: store as unknown as Store,
    acquireWatcherRemoval: async (path) => {
      teardown()
      const gate = acquireWatcherRemovalGate(path)
      return { finish: async () => gate.release() }
    },
    closeWatchers: vi.fn(async () => teardown()),
    stopPtys,
    preservedBranchCleanup: { preserveHead: (result) => result ?? {}, remember: vi.fn() },
    purge: () => expect(existsSync(worktreePath)).toBe(false),
    onRemoved: () => {},
    publish: () => {}
  }
}

describe('finishing an interrupted worktree removal after a restart', () => {
  it('leaves the same branch checked out again at a new head', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const head = (await git(['rev-parse', 'feature'])).trim()
    await git(['worktree', 'remove', worktreePath])
    await git(['worktree', 'add', '-q', worktreePath, 'feature'])
    await writeFile(join(worktreePath, 'work.txt'), 'work\n')
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'work'], worktreePath)

    const { outcome, purged, records } = await finishAfterRestart({ head, force: true })

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(records).toEqual([])
    expect(existsSync(join(worktreePath, 'work.txt'))).toBe(true)
    expect(purged).toEqual([])
  })

  it('finishes a reviewed cleanup removal whose checkout Git already deleted before the restart', async () => {
    await git(['worktree', 'remove', worktreePath])
    // A stale proof: it can't match anything, and is never read once the checkout is gone.
    const expectedCheckoutIdentity = {
      instanceId: 'removal-fixture',
      root: worktreePath,
      rootKey: 'recorded',
      markerKey: 'recorded',
      gitDir: join(repoPath, '.git', 'worktrees', 'feature'),
      adminKey: 'recorded',
      nonce: '00000000-0000-0000-0000-000000000000'
    }

    const { outcome, purged, records } = await finishAfterRestart({
      reviewed: { expectedInstanceId: 'removal-fixture', expectedCheckoutIdentity }
    })

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(purged).toEqual([`repo-1::${worktreePath}`])
    expect(records).toEqual([])
  })

  it('prunes a reviewed checkout whose folder is gone but Git still registers', async () => {
    await removeTree(worktreePath)
    const expectedCheckoutIdentity = {
      instanceId: 'removal-fixture',
      root: worktreePath,
      rootKey: 'recorded',
      markerKey: 'recorded',
      gitDir: join(repoPath, '.git', 'worktrees', 'feature'),
      adminKey: 'recorded',
      nonce: '00000000-0000-0000-0000-000000000000'
    }

    const { outcome, purged } = await finishAfterRestart({
      reviewed: { expectedInstanceId: 'removal-fixture', expectedCheckoutIdentity }
    })

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(await git(['worktree', 'list', '--porcelain'])).not.toContain(worktreePath)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('leaves a different checkout that appears right after the resume found the reviewed one gone', async () => {
    await git(['worktree', 'remove', worktreePath])
    const expectedCheckoutIdentity = {
      instanceId: 'removal-fixture',
      root: worktreePath,
      rootKey: 'recorded',
      markerKey: 'recorded',
      gitDir: join(repoPath, '.git', 'worktrees', 'feature'),
      adminKey: 'recorded',
      nonce: '00000000-0000-0000-0000-000000000000'
    }
    // The seam: the resume sees the path empty, then another checkout of the same branch and
    // head is registered there before the finish reads Git.
    const exists = vi.mocked(worktreeCheckoutExists)
    const actualExists = exists.getMockImplementation()!
    exists.mockImplementationOnce(async (path) => {
      const found = await actualExists(path)
      // Clean, so a guardless `git worktree remove` would delete it.
      await git(['worktree', 'add', '-q', worktreePath, 'feature'])
      return found
    })

    const { outcome, purged } = await finishAfterRestart({
      reviewed: { expectedInstanceId: 'removal-fixture', expectedCheckoutIdentity }
    })

    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/not removed/) })
    expect(existsSync(join(worktreePath, 'seed.txt'))).toBe(true)
    expect(await git(['worktree', 'list', '--porcelain'])).toContain(`worktree ${worktreePath}`)
    expect(purged).toEqual([])
  })
})

installRealWorkerThreadChildProcesses()
