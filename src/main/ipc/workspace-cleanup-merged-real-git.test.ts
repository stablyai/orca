import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceCleanupCandidate } from '../../shared/workspace-cleanup'
import { listRepoWorktrees } from '../repo-worktrees'
import { buildWorkspaceCleanupCandidate } from './workspace-cleanup-candidate'
import type { WorkspaceCleanupGitRoute } from './workspace-cleanup-git-route'
import { createWorkspaceCleanupBaseRefResolver } from './workspace-cleanup-merged'
import { mergeCleanupGitWorktree } from './workspace-cleanup-worktree-listing'

const ROUTE: WorkspaceCleanupGitRoute = { kind: 'local', hostId: LOCAL_EXECUTION_HOST_ID }
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid']

let root = ''

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function commit(cwd: string, file: string, message: string): void {
  execFileSync('git', ['-C', cwd, 'add', '--', file], { stdio: 'pipe' })
  execFileSync('git', ['-C', cwd, ...IDENTITY, 'commit', '--quiet', '-m', message], {
    stdio: 'pipe'
  })
}

async function addWorktree(repo: string, branch: string): Promise<string> {
  const worktreePath = join(root, branch)
  git(repo, ['worktree', 'add', '--quiet', '-b', branch, worktreePath])
  return worktreePath
}

async function scanCandidate(
  repo: Repo,
  worktreePath: string,
  overrides: { baseRef?: string } = {}
): Promise<WorkspaceCleanupCandidate> {
  const listed = (await listRepoWorktrees(repo)).find((entry) => entry.path === worktreePath)
  if (!listed) {
    throw new Error(`worktree not listed: ${worktreePath}`)
  }
  const merged = mergeCleanupGitWorktree(
    { getWorktreeMeta: () => undefined },
    repo,
    LOCAL_EXECUTION_HOST_ID,
    listed,
    1
  )
  const worktree = { ...merged, ...overrides }
  return buildWorkspaceCleanupCandidate({
    repo,
    worktree,
    scannedAt: Date.now(),
    route: ROUTE,
    skipGit: false,
    forceGitCheck: true,
    signals: { resolveBaseRef: createWorkspaceCleanupBaseRefResolver(repo, ROUTE) }
  })
}

describe('workspace cleanup merged signal (real git)', () => {
  let repo: Repo
  const worktrees: Record<string, string> = {}

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-cleanup-merged-')))
    const emptyConfig = join(root, 'gitconfig')
    await writeFile(emptyConfig, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    const repoPath = join(root, 'repo')
    git(root, ['init', '--quiet', '--bare', join(root, 'origin.git')])
    git(root, ['init', '--quiet', repoPath])
    git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await writeFile(join(repoPath, 'README.md'), 'base\n')
    commit(repoPath, 'README.md', 'initial')
    git(repoPath, ['remote', 'add', 'origin', join(root, 'origin.git')])
    git(repoPath, ['push', '--quiet', 'origin', 'main'])
    repo = { id: 'repo-1', path: repoPath, displayName: 'Repo', badgeColor: '#000', addedAt: 0 }

    // Created before main moves, and never committed to.
    worktrees.fresh = await addWorktree(repoPath, 'feature-fresh')
    for (const branch of ['feature-merged', 'feature-dirty', 'feature-open']) {
      worktrees[branch] = await addWorktree(repoPath, branch)
      await writeFile(join(worktrees[branch], `${branch}.txt`), `${branch}\n`)
      commit(worktrees[branch], `${branch}.txt`, `work on ${branch}`)
    }
    for (const branch of ['feature-merged', 'feature-dirty']) {
      git(repoPath, [...IDENTITY, 'merge', '--quiet', '--no-ff', '-m', `merge ${branch}`, branch])
    }
    git(repoPath, ['push', '--quiet', 'origin', 'main', 'feature-open'])
    await writeFile(join(worktrees['feature-dirty'], 'scratch.txt'), 'uncommitted\n')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it('flags a branch whose commits are all in the default base and keeps it ready', async () => {
    const candidate = await scanCandidate(repo, worktrees['feature-merged'])

    expect(candidate.reasons).toContain('merged')
    expect(candidate.mergedBaseRef).toBe('origin/main')
    expect(candidate.blockers).toEqual([])
    expect(candidate).toMatchObject({ tier: 'ready', selectedByDefault: true })
  })

  it('does not flag a branch with commits the base lacks', async () => {
    const candidate = await scanCandidate(repo, worktrees['feature-open'])

    expect(candidate.reasons).not.toContain('merged')
    expect(candidate.mergedBaseRef).toBeUndefined()
  })

  it('keeps a merged worktree with uncommitted changes blocked', async () => {
    const candidate = await scanCandidate(repo, worktrees['feature-dirty'])

    expect(candidate.reasons).toContain('merged')
    expect(candidate.blockers).toContain('dirty-files')
    expect(candidate).toMatchObject({ tier: 'protected', selectedByDefault: false })
  })

  it('does not call a never-committed branch merged after the base moves on', async () => {
    const candidate = await scanCandidate(repo, worktrees.fresh)

    expect(candidate.reasons).not.toContain('merged')
  })

  it('never compares a branch against its own remote copy', async () => {
    const candidate = await scanCandidate(repo, worktrees['feature-open'], {
      baseRef: 'origin/feature-open'
    })

    expect(candidate.reasons).not.toContain('merged')
  })

  it('keeps the prunable flag through the routed listing and blocks on unreadable git', async () => {
    const gone = await addWorktree(repo.path, 'feature-gone')
    await rm(gone, { recursive: true, force: true })

    const listed = (await listRepoWorktrees(repo)).find((entry) => entry.path === gone)
    expect(listed?.prunable).toBe(true)
    const candidate = await scanCandidate(repo, gone)

    expect(candidate.reasons).toContain('prunable')
    expect(candidate.blockers).toContain('git-status-error')
    expect(candidate).toMatchObject({ tier: 'protected', selectedByDefault: false })
  })
})
