import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeRuntimePathForComparison } from '../../shared/file-access/cross-platform-path'
import { scanNestedRepos } from './nested-repo-discovery'
import { createNestedRepoImportTargetResolver } from './nested-repo-import-target'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  })
}

function initSeedRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'main'])
  writeFileSync(join(dir, 'README.md'), 'seed\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-m', 'init'])
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('nested repo discovery and import with bare stores and linked worktrees (#48369)', () => {
  it('collapses a bare store and its linked worktrees into one discovered and imported project', async () => {
    const root = makeTempDir('orca-bare-import-')
    const seed = join(root, 'seed')
    initSeedRepo(seed)

    const example = join(root, 'example')
    mkdirSync(example, { recursive: true })
    const bareStore = join(example, '.bare')
    const mainWorktree = join(example, 'main')
    const featureWorktree = join(example, 'feature')
    git(example, ['clone', '--bare', seed, '.bare'])
    git(bareStore, ['worktree', 'add', mainWorktree, 'main'])
    git(bareStore, ['worktree', 'add', '-b', 'feature', featureWorktree, 'main'])

    const scan = await scanNestedRepos({ path: example })
    expect(scan.selectedPathKind).toBe('non_git_folder')
    expect(scan.repos.map((repo) => normalizeRuntimePathForComparison(repo.path))).toEqual([
      normalizeRuntimePathForComparison(bareStore)
    ])

    const resolver = createNestedRepoImportTargetResolver()
    const resolvedBare = await resolver.resolveLocal(bareStore)
    const resolvedMain = await resolver.resolveLocal(mainWorktree)
    const resolvedFeature = await resolver.resolveLocal(featureWorktree)
    expect(normalizeRuntimePathForComparison(resolvedBare)).toBe(
      normalizeRuntimePathForComparison(bareStore)
    )
    expect(normalizeRuntimePathForComparison(resolvedMain)).toBe(
      normalizeRuntimePathForComparison(bareStore)
    )
    expect(normalizeRuntimePathForComparison(resolvedFeature)).toBe(
      normalizeRuntimePathForComparison(bareStore)
    )
  })

  it('prefers the main non-bare clone over a linked worktree that sorts alphabetically earlier', async () => {
    const root = makeTempDir('orca-linked-scan-')
    const folder = join(root, 'workspace')
    const mainClone = join(folder, 'z-clone')
    const linkedWorktree = join(folder, 'a-feature')
    initSeedRepo(mainClone)
    git(mainClone, ['worktree', 'add', '-b', 'feature', linkedWorktree, 'main'])

    const scan = await scanNestedRepos({ path: folder })
    expect(scan.repos.map((repo) => normalizeRuntimePathForComparison(repo.path))).toEqual([
      normalizeRuntimePathForComparison(mainClone)
    ])
  })

  it('collapses sibling linked worktrees whose bare store lives outside the scanned folder', async () => {
    const root = makeTempDir('orca-external-bare-')
    const seed = join(root, 'seed')
    initSeedRepo(seed)

    const bareStore = join(root, 'repo.git')
    git(root, ['clone', '--bare', seed, bareStore])
    const worktreesDir = join(root, 'worktrees')
    mkdirSync(worktreesDir, { recursive: true })
    const wtMain = join(worktreesDir, 'main')
    const wtFeat = join(worktreesDir, 'feature')
    git(bareStore, ['worktree', 'add', wtMain, 'main'])
    git(bareStore, ['worktree', 'add', '-b', 'feature', wtFeat, 'main'])

    const scan = await scanNestedRepos({ path: worktreesDir })
    expect(scan.repos).toHaveLength(1)

    const resolver = createNestedRepoImportTargetResolver()
    expect(
      normalizeRuntimePathForComparison(await resolver.resolveLocal(scan.repos[0]!.path))
    ).toBe(normalizeRuntimePathForComparison(bareStore))

    const linkedWorktreesDir = join(root, 'linked-worktrees')
    symlinkSync(worktreesDir, linkedWorktreesDir, process.platform === 'win32' ? 'junction' : 'dir')
    const symlinkScan = await scanNestedRepos({ path: linkedWorktreesDir })
    expect(symlinkScan.repos).toHaveLength(1)
    const symlinkResolver = createNestedRepoImportTargetResolver()
    expect(
      normalizeRuntimePathForComparison(
        await symlinkResolver.resolveLocal(symlinkScan.repos[0]!.path)
      )
    ).toBe(normalizeRuntimePathForComparison(bareStore))
  })

  it('keeps independent repositories separate', async () => {
    const root = makeTempDir('orca-independent-repos-')
    const folder = join(root, 'projects')
    const repoA = join(folder, 'repo-a')
    const repoB = join(folder, 'repo-b')
    initSeedRepo(repoA)
    initSeedRepo(repoB)

    const scan = await scanNestedRepos({ path: folder })
    expect(scan.repos.map((repo) => normalizeRuntimePathForComparison(repo.path))).toEqual([
      normalizeRuntimePathForComparison(repoA),
      normalizeRuntimePathForComparison(repoB)
    ])
  })
})
