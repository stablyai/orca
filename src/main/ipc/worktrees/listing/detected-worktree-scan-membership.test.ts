// The detected scan's 5 s row cache stands only for repos the membership model leaves to Git. A repo
// whose model reads Git's files keeps no rows there: every scan re-validates it, and stays fresh.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

vi.mock('../../../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))

const {
  __getDetectedWorktreeScanCacheStatsForTests,
  __resetDetectedWorktreeScanCacheForTests,
  listDetectedGitWorktrees
} = await import('./detected-worktree-scan-cache')
const { _resetWorktreeMembershipModelsForTests } =
  await import('../../../git/worktree-membership/worktree-membership-store')
const { _resetWorktreeScanCacheForTests } = await import('../../../git/worktree-scan-cache')

const execFileAsync = promisify(execFile)
const store = { captureNativeLocalWorktreeMetadataScanExpectation: () => undefined }

let scratchDir = ''
let repo: Repo
let linked = ''

async function git(args: string[], cwd = repo.path): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function commitIn(worktreePath: string, name: string): Promise<string> {
  await writeFile(join(worktreePath, `${name}.txt`), `${name}\n`)
  await git(['add', '-A'], worktreePath)
  await git(
    ['-c', 'user.email=d@example.invalid', '-c', 'user.name=D', 'commit', '-qm', name],
    worktreePath
  )
  return git(['rev-parse', 'HEAD'], worktreePath)
}

async function scan(): Promise<{ fresh: boolean; head: string | undefined }> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a local scan reads only the metadata-expectation capture off the store.
  const result = await listDetectedGitWorktrees(store as never, repo)
  return {
    fresh: result.fresh,
    head: result.gitWorktrees.find((row) => row.path === linked)?.head
  }
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-detected-membership-')))
  repo = {
    id: 'repo-1',
    path: join(scratchDir, 'repo'),
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  await mkdir(repo.path)
  await git(['init', '-q', '-b', 'main'])
  await commitIn(repo.path, 'seed')
  linked = join(scratchDir, 'linked')
  await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
  __resetDetectedWorktreeScanCacheForTests()
  _resetWorktreeScanCacheForTests()
  _resetWorktreeMembershipModelsForTests()
})

afterEach(async () => {
  vi.restoreAllMocks()
  __resetDetectedWorktreeScanCacheForTests()
  _resetWorktreeMembershipModelsForTests()
  await rm(scratchDir, { recursive: true, force: true })
})

describe('detected worktree scan over membership models', () => {
  it('keeps no rows for a repo whose model reads Git files, and sees an unreported change', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await scan()
    expect(__getDetectedWorktreeScanCacheStatsForTests().cacheSize).toBe(0)

    const head = await commitIn(linked, 'unreported')
    now += 1_000
    await expect(scan()).resolves.toEqual({ fresh: true, head })
  })

  it('keeps its 5 s row cache for a repo the model leaves to Git', async () => {
    // An include is a layout only Git resolves.
    await git(['config', 'include.path', join(scratchDir, 'absent.gitconfig')])
    const first = await scan()
    expect(__getDetectedWorktreeScanCacheStatsForTests().cacheSize).toBe(1)
    await expect(scan()).resolves.toEqual({ fresh: false, head: first.head })
  })
})
