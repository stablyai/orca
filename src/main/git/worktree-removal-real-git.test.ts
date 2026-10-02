// Real-binary coverage for worktree removal: the mocked-runner suite cannot prove what Git deletes,
// deregisters and refuses, or that deleting a checkout leaves Node's file pool free.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { listWorktreesStrict, removeWorktree } from './worktree'
import { areWorktreePathsEqual } from './worktree-path-comparison'
import { isPrunableGitFileWorktree } from '../worktree-prunable-git-file'
import { removeStaleLocalWorktreeRegistration } from '../local-worktree-removal-recovery'
import { sweepStaleWorktreeTrash, WORKTREE_TRASH_DIR_NAME } from '../worktree-trash'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''
let workspaceRoot = ''
let worktreePath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

// Why parsed: Git prints forward slashes on Windows, so raw text never contains a joined path.
async function isRegistered(path: string): Promise<boolean> {
  return (await listWorktreesStrict(repoPath)).some((worktree) =>
    areWorktreePathsEqual(worktree.path, path)
  )
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/..., and Orca
  // matches the worktree it is removing against Git's own list.
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-worktree-removal-')))
  repoPath = join(scratchDir, 'repo')
  workspaceRoot = join(scratchDir, 'workspaces')
  worktreePath = join(workspaceRoot, 'repo', 'feature')
  await mkdir(repoPath, { recursive: true })
  await mkdir(join(workspaceRoot, 'repo'), { recursive: true })
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.email', 'removal@example.invalid'], repoPath)
  await git(['config', 'user.name', 'Worktree Removal'], repoPath)
  // Why: a commit's detached auto-maintenance can still be writing packs when teardown deletes the repo.
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

  // Why: branch cleanup asks the review host only when `-d` refuses; these pin when Git refuses.
  it('deletes a pushed branch while its remote-tracking ref exists, and keeps it once pruned', async () => {
    const originPath = join(scratchDir, 'origin.git')
    await git(['init', '-q', '--bare', originPath], scratchDir)
    await git(['remote', 'add', 'origin', originPath], repoPath)
    await writeFile(join(worktreePath, 'work.txt'), 'work\n')
    await git(['add', 'work.txt'], worktreePath)
    await git(['commit', '-qm', 'work'], worktreePath)
    await git(['push', '-q', '--set-upstream', 'origin', 'feature'], worktreePath)
    const siblingPath = join(workspaceRoot, 'repo', 'sibling')
    await git(['worktree', 'add', '-q', siblingPath, '-b', 'sibling'], repoPath)
    await writeFile(join(siblingPath, 'sibling.txt'), 'sibling\n')
    await git(['add', 'sibling.txt'], siblingPath)
    await git(['commit', '-qm', 'sibling'], siblingPath)
    await git(['push', '-q', '--set-upstream', 'origin', 'sibling'], siblingPath)
    const siblingHead = (await git(['rev-parse', 'HEAD'], siblingPath)).trim()
    await git(['branch', '-r', '-d', 'origin/sibling'], repoPath)

    await expect(removeWorktree(repoPath, worktreePath, false)).resolves.toEqual({})
    await expect(removeWorktree(repoPath, siblingPath, false)).resolves.toEqual({
      preservedBranch: { branchName: 'sibling', head: siblingHead }
    })

    expect(await git(['branch', '--list', 'feature'], repoPath)).toBe('')
    expect(await git(['rev-parse', 'refs/heads/sibling'], repoPath)).toBe(`${siblingHead}\n`)
  })

  it('refuses to delete a dirty checkout', async () => {
    await writeFile(join(worktreePath, 'seed.txt'), 'edited\n')

    await expect(removeWorktree(repoPath, worktreePath, false)).rejects.toThrow()
    expect(existsSync(join(worktreePath, 'seed.txt'))).toBe(true)
    expect(await isRegistered(worktreePath)).toBe(true)
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

// Why: Orca cuts workspace branches with `--no-track`, so `-d` compares against the main checkout's
// HEAD; these pin which refused branches are deleted because their base already holds the head.
describe('removal of a branch whose base already holds its head', () => {
  let originPath = ''

  async function commitOn(cwd: string, file: string): Promise<string> {
    await writeFile(join(cwd, file), `${file}\n`)
    await git(['add', file], cwd)
    await git(['commit', '-qm', file], cwd)
    return (await git(['rev-parse', 'HEAD'], cwd)).trim()
  }

  async function addWorkspace(name: string, base: string, saveBase = true): Promise<string> {
    const path = join(workspaceRoot, 'repo', name)
    await git(['worktree', 'add', '-q', '--no-track', '-b', name, path, base], repoPath)
    if (saveBase) {
      await git(['config', `branch.${name}.base`, base], repoPath)
    }
    return path
  }

  beforeEach(async () => {
    await removeWorktree(repoPath, worktreePath, false)
    await git(['branch', '-M', 'main'], repoPath)
    originPath = join(scratchDir, 'origin.git')
    await git(['init', '-q', '--bare', originPath], scratchDir)
    await git(['remote', 'add', 'origin', originPath], repoPath)
    await git(['push', '-q', 'origin', 'main'], repoPath)
  })

  it('deletes an untouched workspace cut from origin/main while local main is behind', async () => {
    const ahead = join(workspaceRoot, 'repo', 'ahead')
    await git(['worktree', 'add', '-q', '--detach', ahead, 'main'], repoPath)
    await commitOn(ahead, 'upstream.txt')
    await git(['push', '-q', 'origin', 'HEAD:main'], ahead)
    await removeWorktree(repoPath, ahead, true, { deleteBranch: false })
    await git(['fetch', '-q', 'origin'], repoPath)
    await git(['remote', 'set-head', 'origin', 'main'], repoPath)
    // Only origin/HEAD names the base here.
    const path = await addWorkspace('untouched', 'refs/remotes/origin/main', false)

    await expect(removeWorktree(repoPath, path, false)).resolves.toEqual({})
    expect(await git(['branch', '--list', 'untouched'], repoPath)).toBe('')
  })

  it('deletes an untouched workspace while the main checkout is on another branch', async () => {
    await git(['checkout', '-q', '-b', 'my-local-work'], repoPath)
    await commitOn(repoPath, 'local.txt')
    // main moves on after the checkout left it, so HEAD no longer holds main's tip.
    const next = (
      await git(['commit-tree', 'HEAD^{tree}', '-p', 'main', '-m', 'next'], repoPath)
    ).trim()
    await git(['update-ref', 'refs/heads/main', next], repoPath)
    const path = await addWorkspace('untouched', 'refs/heads/main')

    await expect(removeWorktree(repoPath, path, false)).resolves.toEqual({})
    expect(await git(['branch', '--list', 'untouched'], repoPath)).toBe('')
  })

  it("deletes a workspace opened on someone's open review branch with no commits", async () => {
    const author = join(workspaceRoot, 'repo', 'author')
    await git(['worktree', 'add', '-q', '-b', 'author-work', author, 'main'], repoPath)
    await commitOn(author, 'feature.txt')
    await git(['push', '-q', 'origin', 'HEAD:feature-x'], author)
    await removeWorktree(repoPath, author, true, { deleteBranch: false })
    await git(['branch', '-D', 'author-work'], repoPath)
    await git(['fetch', '-q', 'origin'], repoPath)
    const path = await addWorkspace('feature-x', 'refs/remotes/origin/feature-x')

    await expect(removeWorktree(repoPath, path, false)).resolves.toEqual({})
    expect(await git(['branch', '--list', 'feature-x'], repoPath)).toBe('')
  })

  it('keeps a workspace with a commit its base does not hold', async () => {
    await git(['checkout', '-q', '-b', 'my-local-work'], repoPath)
    await git(['remote', 'set-head', 'origin', 'main'], repoPath)
    const path = await addWorkspace('unpushed', 'refs/remotes/origin/main')
    const head = await commitOn(path, 'unpushed.txt')

    await expect(removeWorktree(repoPath, path, false)).resolves.toEqual({
      preservedBranch: { branchName: 'unpushed', head }
    })
    expect(await git(['rev-parse', 'refs/heads/unpushed'], repoPath)).toBe(`${head}\n`)
  })
})

// Why: a bare repo's HEAD names a branch without checking it out, so neither `-d` nor the checked-out
// guard refuses it, and the base check must not count the branch as its own base.
describe.each([
  ['a bare clone', 'project.git', ''],
  ['a .bare folder behind a .git file', 'project', '.bare']
])('removal of the branch HEAD names in %s', (_layout, projectName, bareDirName) => {
  it('keeps it when it has a commit its upstream does not', async () => {
    const originPath = join(scratchDir, 'origin.git')
    await git(['init', '-q', '--bare', originPath], scratchDir)
    await git(['push', '-q', originPath, 'HEAD:refs/heads/main'], repoPath)
    const projectPath = join(scratchDir, projectName)
    const barePath = bareDirName ? join(projectPath, bareDirName) : projectPath
    await git(['clone', '-q', '--bare', originPath, barePath], scratchDir)
    if (bareDirName) {
      await writeFile(join(projectPath, '.git'), `gitdir: ./${bareDirName}\n`)
    }
    await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], projectPath)
    await git(['fetch', '-q', 'origin'], projectPath)
    await git(['branch', '-q', '-u', 'origin/main', 'main'], projectPath)
    const mainCheckout = join(scratchDir, 'main-checkout')
    await git(['worktree', 'add', '-q', mainCheckout, 'main'], projectPath)
    await git(['config', 'user.email', 'removal@example.invalid'], mainCheckout)
    await git(['config', 'user.name', 'Worktree Removal'], mainCheckout)
    await writeFile(join(mainCheckout, 'unpushed.txt'), 'unpushed\n')
    await git(['add', 'unpushed.txt'], mainCheckout)
    await git(['commit', '-qm', 'unpushed'], mainCheckout)
    const head = (await git(['rev-parse', 'HEAD'], mainCheckout)).trim()

    await expect(removeWorktree(projectPath, mainCheckout, false)).resolves.toEqual({
      preservedBranch: { branchName: 'main', head }
    })
    expect(await git(['rev-parse', 'refs/heads/main'], projectPath)).toBe(`${head}\n`)
  })
})

// Why: Git forbids checking out a branch a worktree has, so a user looks at it with a detached HEAD;
// that is no branch, and the commits Git just refused to drop must not be deleted.
it('keeps a branch with unpushed commits while the main checkout is detached at it', async () => {
  const originPath = join(scratchDir, 'origin.git')
  await git(['init', '-q', '--bare', originPath], scratchDir)
  await git(['remote', 'add', 'origin', originPath], repoPath)
  await git(['push', '-q', '--set-upstream', 'origin', 'feature'], worktreePath)
  await writeFile(join(worktreePath, 'unpushed.txt'), 'unpushed\n')
  await git(['add', 'unpushed.txt'], worktreePath)
  await git(['commit', '-qm', 'unpushed'], worktreePath)
  const head = (await git(['rev-parse', 'HEAD'], worktreePath)).trim()
  await git(['checkout', '-q', '--detach', 'feature'], repoPath)

  await expect(removeWorktree(repoPath, worktreePath, false)).resolves.toEqual({
    preservedBranch: { branchName: 'feature', head }
  })
  expect(await git(['rev-parse', 'refs/heads/feature'], repoPath)).toBe(`${head}\n`)
})

function isCaseInsensitiveFilesystem(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), 'orca-case-probe-'))
  try {
    writeFileSync(join(probeDir, 'probe'), '')
    return existsSync(join(probeDir, 'PROBE'))
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

// Why: on macOS and Windows `refs/heads/feat` opens the ref file of `Feat`, so a HEAD spelled in
// another case names the branch itself. On a case-sensitive filesystem that HEAD names nothing.
it.runIf(isCaseInsensitiveFilesystem())(
  'keeps the branch a bare repo HEAD names in another case',
  async () => {
    const originPath = join(scratchDir, 'origin.git')
    await git(['init', '-q', '--bare', originPath], scratchDir)
    await git(['push', '-q', originPath, 'HEAD:refs/heads/main'], repoPath)
    const projectPath = join(scratchDir, 'project.git')
    await git(['clone', '-q', '--bare', originPath, projectPath], scratchDir)
    await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], projectPath)
    await git(['branch', 'Feat', 'main'], projectPath)
    await git(['push', '-q', 'origin', 'Feat'], projectPath)
    await git(['fetch', '-q', 'origin'], projectPath)
    await git(['branch', '-q', '-u', 'origin/Feat', 'Feat'], projectPath)
    await git(['symbolic-ref', 'HEAD', 'refs/heads/feat'], projectPath)
    const checkout = join(scratchDir, 'feat-checkout')
    await git(['worktree', 'add', '-q', checkout, 'Feat'], projectPath)
    await git(['config', 'user.email', 'removal@example.invalid'], checkout)
    await git(['config', 'user.name', 'Worktree Removal'], checkout)
    await writeFile(join(checkout, 'unpushed.txt'), 'unpushed\n')
    await git(['add', 'unpushed.txt'], checkout)
    await git(['commit', '-qm', 'unpushed'], checkout)
    const head = (await git(['rev-parse', 'HEAD'], checkout)).trim()

    await expect(removeWorktree(projectPath, checkout, false)).resolves.toEqual({
      preservedBranch: { branchName: 'Feat', head }
    })
    expect(await git(['rev-parse', 'refs/heads/Feat'], projectPath)).toBe(`${head}\n`)
  }
)

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
    // Outside hard links drop to one link only once the checkout's copies are gone, wherever the
    // delete runs, so the window below covers the whole delete rather than just the call.
    const sentinelRoot = join(scratchDir, 'sentinels')
    await mkdir(sentinelRoot)
    const sentinels: string[] = []
    for (let index = 0; index < POOL_FIXTURE_FILES; index += POOL_SENTINEL_EVERY) {
      const sentinel = join(sentinelRoot, `file-${index}`)
      await link(join(bulkPath, `file-${index}.js`), sentinel)
      sentinels.push(sentinel)
    }
    const checkoutDeleted = (): boolean => sentinels.every((path) => statSync(path).nlink === 1)
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
    const sampler = setInterval(() => {
      maxQueued = Math.max(maxQueued, queuedFsRequests())
    }, 1)
    try {
      while (!removalSettled || !checkoutDeleted()) {
        expect(performance.now() - startedAt).toBeLessThan(60_000)
        maxQueued = Math.max(maxQueued, queuedFsRequests())
        const statStartedAt = performance.now()
        await stat(probePath)
        maxStatMs = Math.max(maxStatMs, performance.now() - statStartedAt)
        statCount += 1
      }
    } finally {
      clearInterval(sampler)
    }
    const deletionMs = performance.now() - startedAt
    await removal

    console.log(
      `[pool] files=${POOL_FIXTURE_FILES} delete=${deletionMs.toFixed(0)}ms stats=${statCount} maxStat=${maxStatMs.toFixed(1)}ms maxQueuedFsRequests=${maxQueued}`
    )
    expect(existsSync(worktreePath)).toBe(false)
    expect(maxQueued).toBeLessThan(32)
    expect(maxStatMs).toBeLessThan(deletionMs / 4)
  }, 120_000)
})
