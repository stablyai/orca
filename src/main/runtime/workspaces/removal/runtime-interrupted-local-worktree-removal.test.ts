import type { Repo } from '../../../../shared/repo-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { WorktreeRemovalRecord } from '../../../workspaces/removal/worktree-removal-records'
import { installRealWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDefaultSettings } from '../../../../shared/constants'
import { getProjectHostSetupWorktreeMeta } from '../../../../shared/project-host-setup-lookup'

import { removeTree } from '../../../../shared/windows-transient-lock-removal'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { Store } from '../../../persistence/loading-store/store'
import type * as HostTreeRemoval from '../../../filesystem/host-tree-removal'
import { removeHostTree } from '../../../filesystem/host-tree-removal'

import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'
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
async function isRegistered(path: string): Promise<boolean> {
  return (await listWorktreesStrict(repoPath)).some((worktree) =>
    areWorktreePathsEqual(worktree.path, path)
  )
}

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
    requestedAt: 1
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
  it.each(['partial', 'detached', 'keep-registered', 'keep-unregistered'])(
    'finishes the accepted %s pending checkout after restart',
    async (kind) => {
      const head = (await git(['rev-parse', 'feature'])).trim()
      if (kind === 'keep-unregistered') {
        await git(['worktree', 'remove', worktreePath])
      }
      const keep = kind.startsWith('keep-')
      if (!keep) {
        await (kind === 'partial'
          ? unlink(join(worktreePath, 'seed.txt'))
          : git(['checkout', '--detach', '-q'], worktreePath))
      }
      const { outcome, purged, records } = await finishAfterRestart({
        force: kind === 'partial',
        branch: kind === 'detached' ? '' : 'feature',
        head: keep ? head : (await git(['rev-parse', 'HEAD'], worktreePath)).trim(),
        deleteBranch: keep ? false : undefined
      })
      expect(outcome).toMatchObject({ status: 'removed' })
      expect(records).toEqual([])
      expect(existsSync(worktreePath)).toBe(false)
      expect(await isRegistered(worktreePath)).toBe(false)
      expect((await git(['branch', '--list', 'feature'])).trim() !== '').toBe(
        keep || kind === 'detached'
      )
      expect(purged).toEqual([`repo-1::${worktreePath}`])
      if (keep) {
        expect((await git(['rev-parse', 'feature'])).trim()).toBe(head)
        expect(outcome).not.toHaveProperty('preservedBranch')
      }
    }
  )

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
})

installRealWorkerThreadChildProcesses()

it.each(['remote-first', 'local-first', 'missing-local'])(
  'recovers only the local owner with a %s same-ID catalog',
  async (order) => {
    const remote: Repo = {
      ...repo,
      path: join(scratchDir, 'nonlocal-repo'),
      connectionId: 'ssh-fixture'
    }
    const repoRows =
      order === 'remote-first'
        ? [remote, repo]
        : order === 'local-first'
          ? [repo, remote]
          : [remote]
    const { outcome, purged, records } = await finishAfterRestart({ repoRows })
    expect(outcome.status).toBe('removed')
    expect(records).toEqual([])
    if (order === 'missing-local') {
      expect(purged).toEqual([])
      expect(existsSync(worktreePath)).toBe(true)
      expect(await isRegistered(worktreePath)).toBe(true)
    } else {
      expect(purged).toEqual([`repo-1::${worktreePath}`])
      expect(existsSync(worktreePath)).toBe(false)
      expect(await isRegistered(worktreePath)).toBe(false)
    }
  }
)
