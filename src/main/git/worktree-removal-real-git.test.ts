// Real Git verifies deletion/refusal behavior and file-pool responsiveness beyond mocked argv.
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { classifyWorktreeForceDeleteReason } from '../../shared/worktree/removal'
import { formatWorktreeRemovalError } from '../ipc/worktree-logic'
import { assertWorktreeCleanForRemoval, listWorktreesStrict, removeWorktree } from './worktree'
import { areWorktreePathsEqual } from './worktree-path-comparison'
import { isPrunableGitFileWorktree } from '../worktree-prunable-git-file'
import { removeStaleLocalWorktreeRegistration } from '../local-worktree-removal-recovery'
import { sweepStaleWorktreeTrash, WORKTREE_TRASH_DIR_NAME } from '../worktree-trash'

const execFileAsync = promisify(execFile)

installRealWorkerThreadChildProcesses()

let scratchDir = ''
let repoPath = ''
let workspaceRoot = ''
let worktreePath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

// Git prints forward slashes on Windows, so compare parsed paths.
async function isRegistered(path: string): Promise<boolean> {
  return (await listWorktreesStrict(repoPath)).some((worktree) =>
    areWorktreePathsEqual(worktree.path, path)
  )
}

beforeEach(async () => {
  // Canonicalize macOS /var temp paths to match Git's /private/var output.
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-worktree-removal-')))
  repoPath = join(scratchDir, 'repo')
  workspaceRoot = join(scratchDir, 'workspaces')
  worktreePath = join(workspaceRoot, 'repo', 'feature')
  await mkdir(repoPath, { recursive: true })
  await mkdir(join(workspaceRoot, 'repo'), { recursive: true })
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.email', 'removal@example.invalid'], repoPath)
  await git(['config', 'user.name', 'Worktree Removal'], repoPath)
  // Disable detached maintenance that could race fixture teardown.
  await git(['config', 'maintenance.auto', 'false'], repoPath)
  await git(['config', 'gc.auto', '0'], repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  // Committed before the worktree exists so its branch stays merged and branch cleanup can run.
  await mkdir(join(repoPath, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(repoPath, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
})

afterEach(async () => {
  await removeTree(scratchDir)
})

describe('worktree removal against the real Git binary', () => {
  it('deletes the checkout and its registration before returning', async () => {
    await removeWorktree(repoPath, worktreePath, false, { deleteBranch: false })

    expect(existsSync(worktreePath)).toBe(false)
    expect(await isRegistered(worktreePath)).toBe(false)
    expect(existsSync(join(workspaceRoot, 'repo', WORKTREE_TRASH_DIR_NAME))).toBe(false)
  })

  it('leaves sibling worktrees registered', async () => {
    const siblingPath = join(workspaceRoot, 'repo', 'sibling')
    await git(['worktree', 'add', '-q', siblingPath, '-b', 'sibling'], repoPath)

    await removeWorktree(repoPath, worktreePath, false, { deleteBranch: false })

    expect(await isRegistered(siblingPath)).toBe(true)
    expect(existsSync(siblingPath)).toBe(true)
  })

  it('deletes the branch exactly as the in-place removal did', async () => {
    await removeWorktree(repoPath, worktreePath, false)

    expect(await git(['branch', '--list', 'feature'], repoPath)).toBe('')
  })

  it('refuses to delete a dirty checkout', async () => {
    await writeFile(join(worktreePath, 'seed.txt'), 'edited\n')

    await expect(removeWorktree(repoPath, worktreePath, false)).rejects.toThrow()
    expect(existsSync(join(worktreePath, 'seed.txt'))).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
  })

  async function addSubmoduleCheckoutWithLocalCommit(): Promise<{
    subWorktreePath: string
    vendorPath: string
    localCommit: string
  }> {
    const emptyCommit = ['-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit']
    const originPath = join(scratchDir, 'origin')
    await mkdir(originPath)
    await git(['init', '-q'], originPath)
    await git([...emptyCommit, '-q', '--allow-empty', '-m', 'origin'], originPath)
    await git(
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', originPath, 'vendor'],
      repoPath
    )
    await git(['commit', '-qm', 'add vendor'], repoPath)
    const subWorktreePath = join(workspaceRoot, 'repo', 'with-sub')
    await git(['worktree', 'add', '-q', subWorktreePath, '-b', 'with-sub'], repoPath)
    await git(
      ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init'],
      subWorktreePath
    )
    const vendorPath = join(subWorktreePath, 'vendor')
    await git([...emptyCommit, '-q', '--allow-empty', '-m', 'local only'], vendorPath)
    const localCommit = (await git(['rev-parse', 'HEAD'], vendorPath)).trim()
    return { subWorktreePath, vendorPath, localCommit }
  }

  it('refuses a clean checkout with a submodule and offers Force Delete for it', async () => {
    // Force deletion can destroy submodule-only commits; preserve Git's refusal.
    const { subWorktreePath, vendorPath, localCommit } = await addSubmoduleCheckoutWithLocalCommit()
    // Recorded by the parent so its status stays clean.
    await git(['commit', '-qam', 'bump vendor'], subWorktreePath)

    const refusal = await removeWorktree(repoPath, subWorktreePath, false).catch((error) => error)
    expect(refusal).toBeInstanceOf(Error)
    expect(
      classifyWorktreeForceDeleteReason(formatWorktreeRemovalError(refusal, subWorktreePath, false))
    ).toBe('submodules')
    expect(await isRegistered(subWorktreePath)).toBe(true)
    expect((await git(['cat-file', '-t', localCommit], vendorPath)).trim()).toBe('commit')

    await removeWorktree(repoPath, subWorktreePath, true)
    expect(await isRegistered(subWorktreePath)).toBe(false)
  })

  it('names submodules when the dirty check refuses a checkout that has them', async () => {
    // Parent status cannot show the submodule-only commit that Force Delete would destroy.
    const { subWorktreePath } = await addSubmoduleCheckoutWithLocalCommit()
    await git(['commit', '-qam', 'bump vendor'], subWorktreePath)
    await writeFile(join(subWorktreePath, 'notes.txt'), 'draft\n')

    const refusal = await assertWorktreeCleanForRemoval(subWorktreePath).catch((error) => error)
    const message = formatWorktreeRemovalError(refusal, subWorktreePath, false)
    expect(classifyWorktreeForceDeleteReason(message)).toBe('submodules')
    expect(message).toContain('?? notes.txt')
    // Older apps offer Force Delete only for this sentence.
    expect(message).toContain('Worktree has uncommitted or untracked changes')
  })

  it('does not delete a checkout through a malformed registration that names its git file', async () => {
    const markerPath = join(worktreePath, '.git')
    const marker = await readFile(markerPath, 'utf8')
    const adminPath = marker.trim().replace(/^gitdir: /, '')
    await writeFile(join(adminPath, 'gitdir'), `${join(markerPath, '.git')}\n`)
    await writeFile(join(worktreePath, 'untracked.txt'), 'keep this work\n')

    await expect(
      removeWorktree(repoPath, markerPath, true, { deleteBranch: false })
    ).rejects.toThrow()

    expect(await readFile(markerPath, 'utf8')).toBe(marker)
    expect(await readFile(join(worktreePath, 'untracked.txt'), 'utf8')).toBe('keep this work\n')
    expect(await git(['branch', '--list', 'feature'], repoPath)).toContain('feature')
  })

  it('prunes a proven malformed registration while retaining checkout files and its branch', async () => {
    const markerPath = join(worktreePath, '.git')
    const marker = await readFile(markerPath, 'utf8')
    const adminPath = marker.trim().replace(/^gitdir: /, '')
    await writeFile(join(adminPath, 'gitdir'), `${join(markerPath, '.git')}\n`)
    await writeFile(join(worktreePath, 'untracked.txt'), 'keep this work\n')
    const row = (await listWorktreesStrict(repoPath)).find((entry) =>
      areWorktreePathsEqual(entry.path, markerPath)
    )
    expect(row).toBeDefined()
    if (!row) {
      throw new Error('Missing malformed registration')
    }
    expect(await isPrunableGitFileWorktree(row)).toBe(true)

    const result = await removeStaleLocalWorktreeRegistration({
      canonicalWorktreePath: row.path,
      repoPath,
      localWorktreeGitOptions: {},
      registeredWorktree: row,
      deleteBranch: true
    })

    expect(result).toEqual({ preservedBranch: { branchName: 'feature', head: row.head } })
    expect(await readFile(markerPath, 'utf8')).toBe(marker)
    expect(await readFile(join(worktreePath, 'untracked.txt'), 'utf8')).toBe('keep this work\n')
    expect(await git(['rev-parse', 'refs/heads/feature'], repoPath)).toBe(`${row.head}\n`)
    expect(await isRegistered(markerPath)).toBe(false)
    expect(existsSync(adminPath)).toBe(false)
  })

  it('sweeps trash an older release left behind', async () => {
    const stalePath = join(
      workspaceRoot,
      'repo',
      WORKTREE_TRASH_DIR_NAME,
      'wt-1700000000000-deadbeef'
    )
    await mkdir(join(stalePath, 'node_modules'), { recursive: true })

    await sweepStaleWorktreeTrash([workspaceRoot])

    expect(existsSync(stalePath)).toBe(false)
    expect(existsSync(worktreePath)).toBe(true)
  })
})

const POOL_FIXTURE_FILES = 3_000
const POOL_SENTINEL_EVERY = 100

function queuedFsRequests(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === 'FSReqPromise' || resource === 'FSReqCallback').length
}

describe('worktree removal and the Node file pool', () => {
  it('keeps async file I/O responsive while the checkout is deleted', async () => {
    // One flat directory: a recursive delete through the pool would queue every entry at once.
    const bulkPath = join(worktreePath, 'bulk')
    await mkdir(bulkPath)
    for (let start = 0; start < POOL_FIXTURE_FILES; start += 500) {
      await Promise.all(
        Array.from({ length: 500 }, (_unused, offset) =>
          writeFile(
            join(bulkPath, `file-${start + offset}.js`),
            `module.exports = ${start + offset}\n`
          )
        )
      )
    }
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'bulk'], worktreePath)
    // Hard-link counts bound the actual delete window independently of the call's lifetime.
    const sentinelRoot = join(scratchDir, 'sentinels')
    await mkdir(sentinelRoot)
    const sentinels: string[] = []
    for (let index = 0; index < POOL_FIXTURE_FILES; index += POOL_SENTINEL_EVERY) {
      const sentinel = join(sentinelRoot, `file-${index}`)
      await link(join(bulkPath, `file-${index}.js`), sentinel)
      sentinels.push(sentinel)
    }
    const checkoutDeleted = (): boolean => sentinels.every((path) => statSync(path).nlink === 1)
    const deletionStarted = (): boolean => sentinels.some((path) => statSync(path).nlink === 1)
    const probePath = join(repoPath, 'seed.txt')

    let removalSettled = false
    const removal = removeWorktree(repoPath, worktreePath, false, { deleteBranch: false }).finally(
      () => {
        removalSettled = true
      }
    )
    const startedAt = performance.now()
    let maxQueued = 0
    let maxStatMs = 0
    let statCount = 0
    let statsDuringDeletion = 0
    const sampler = setInterval(() => {
      maxQueued = Math.max(maxQueued, queuedFsRequests())
    }, 1)
    try {
      while (!removalSettled || !checkoutDeleted()) {
        expect(performance.now() - startedAt).toBeLessThan(60_000)
        maxQueued = Math.max(maxQueued, queuedFsRequests())
        const deletionInProgress = deletionStarted() && !checkoutDeleted()
        const statStartedAt = performance.now()
        await stat(probePath)
        maxStatMs = Math.max(maxStatMs, performance.now() - statStartedAt)
        if (deletionInProgress && !checkoutDeleted()) {
          statsDuringDeletion += 1
        }
        statCount += 1
      }
    } finally {
      clearInterval(sampler)
    }
    const deletionMs = performance.now() - startedAt
    await removal

    console.log(
      `[pool] files=${POOL_FIXTURE_FILES} delete=${deletionMs.toFixed(0)}ms stats=${statCount} statsDuringDeletion=${statsDuringDeletion} maxStat=${maxStatMs.toFixed(1)}ms maxQueuedFsRequests=${maxQueued}`
    )
    expect(existsSync(worktreePath)).toBe(false)
    expect(maxQueued).toBeLessThan(32)
    expect(statsDuringDeletion).toBeGreaterThan(0)
  }, 120_000)
})
