import path from 'node:path'
import type { LineagePatternMatchOn } from '../../shared/lineage-discovery-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { RepoKind } from '../../shared/repo-types'
import { listWorktrees } from '../git/worktree'
import { matchesTicketKeys } from '../../shared/lineage-ticket-keys'
import type { LineagePatternScanCache } from './lineage-pattern-scan-cache'

const BRANCH_REF_PREFIX = 'refs/heads/'

export type PatternRepo = {
  id: string
  path: string
  displayName: string
  connectionId?: string | null
  kind?: RepoKind
}

export type PatternTarget = {
  repoId: string
  repoName: string
  worktreePath: string
  branch: string
  matchedOn: 'branch' | 'worktree-name'
  matchedKey: string
}

export type DiscoverPatternTargetsArgs = {
  repos: PatternRepo[]
  keys: string[]
  excludePaths?: string[]
  matchOn?: LineagePatternMatchOn
  /** 'all' or the repo ids that may be scanned. */
  repoScope?: 'all' | string[]
  listWorktreesFn?: (repoPath: string) => Promise<GitWorktreeInfo[]>
  patternScanCache?: LineagePatternScanCache
  force?: boolean
}

export type ListRepoWorktreesOptions = {
  listWorktreesFn?: (repoPath: string) => Promise<GitWorktreeInfo[]>
  patternScanCache?: LineagePatternScanCache
  force?: boolean
}

/** invariant: the one per-repo worktree scan; pattern discovery and manual links share its cache. */
export async function listRepoWorktrees(
  repo: PatternRepo,
  { listWorktreesFn = listWorktrees, patternScanCache, force }: ListRepoWorktreesOptions = {}
): Promise<GitWorktreeInfo[]> {
  const load = async (): Promise<GitWorktreeInfo[]> => {
    try {
      return await listWorktreesFn(repo.path)
    } catch {
      return []
    }
  }
  return patternScanCache ? patternScanCache.getOrLoad(repo.path, load, force) : load()
}

export function worktreeBranchName(worktree: GitWorktreeInfo): string {
  return worktree.branch.startsWith(BRANCH_REF_PREFIX)
    ? worktree.branch.slice(BRANCH_REF_PREFIX.length)
    : worktree.branch
}

/** Finds worktrees (primary checkouts included) across local repos whose branch carries a ticket key. */
export async function discoverPatternTargets(
  args: DiscoverPatternTargetsArgs
): Promise<PatternTarget[]> {
  const {
    repos,
    keys,
    excludePaths = [],
    matchOn = 'branch',
    repoScope = 'all',
    listWorktreesFn,
    patternScanCache,
    force
  } = args
  if (keys.length === 0) {
    return []
  }

  // hazard: remote repos are skipped, their git must run on the execution host (SSH boundary)
  const localRepos = repos.filter(
    (repo) => !repo.connectionId && (repoScope === 'all' || repoScope.includes(repo.id))
  )
  const perRepo = await Promise.all(
    localRepos.map(async (repo) => ({
      repo,
      worktrees: await listRepoWorktrees(repo, { listWorktreesFn, patternScanCache, force })
    }))
  )

  const targets: PatternTarget[] = []
  for (const { repo, worktrees } of perRepo) {
    for (const worktree of worktrees) {
      if (worktree.isBare || excludePaths.includes(worktree.path)) {
        continue
      }
      const branch = worktreeBranchName(worktree)
      const candidates: { matchedOn: PatternTarget['matchedOn']; text: string }[] = []
      if (matchOn !== 'worktree-name') {
        candidates.push({ matchedOn: 'branch', text: branch })
      }
      if (matchOn !== 'branch') {
        candidates.push({ matchedOn: 'worktree-name', text: path.basename(worktree.path) })
      }
      for (const { matchedOn, text } of candidates) {
        const matchedKey = keys.find((key) => matchesTicketKeys(text, [key]))
        if (matchedKey) {
          targets.push({
            repoId: repo.id,
            repoName: repo.displayName,
            worktreePath: worktree.path,
            branch,
            matchedOn,
            matchedKey
          })
          break
        }
      }
    }
  }
  return targets
}
