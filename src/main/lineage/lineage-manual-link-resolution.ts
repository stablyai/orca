import path from 'node:path'
import type {
  LineageManualLink,
  LineageMember,
  LineageMemberPullRequest
} from '../../shared/lineage-discovery-types'
import { lineageManualLinkKind } from '../../shared/lineage-manual-link-shape'
import { parsePullRequestReference } from '../../shared/lineage-pr-reference'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import {
  listRepoWorktrees,
  worktreeBranchName,
  type ListRepoWorktreesOptions,
  type PatternRepo
} from './lineage-name-pattern-discovery'

const MANUAL_REASON = 'added manually'

function providerOf(url: string | undefined): Pick<LineageMemberPullRequest, 'provider'> {
  const provider = url ? parsePullRequestReference(url)?.provider : undefined
  return provider ? { provider } : {}
}

function findRepo(repos: PatternRepo[], link: LineageManualLink): PatternRepo | undefined {
  const byId = link.repoId ? repos.find((repo) => repo.id === link.repoId) : undefined
  return (
    byId ?? repos.find((repo) => repo.displayName.toLowerCase() === link.repoName.toLowerCase())
  )
}

function wantsLocalWorktree(link: LineageManualLink): boolean {
  return lineageManualLinkKind(link) === 'worktree' || Boolean(link.branch)
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

function findWorktree(
  link: LineageManualLink,
  worktrees: GitWorktreeInfo[]
): GitWorktreeInfo | undefined {
  const candidates = worktrees.filter((worktree) => !worktree.isBare)
  if (lineageManualLinkKind(link) === 'worktree') {
    const wanted = link.worktreePath
    return wanted ? candidates.find((worktree) => samePath(worktree.path, wanted)) : undefined
  }
  return candidates.find((worktree) => worktreeBranchName(worktree) === link.branch)
}

function baseMember(link: LineageManualLink, repo: PatternRepo | undefined): LineageMember {
  return {
    repoName: repo?.displayName ?? link.repoName,
    branch: link.branch ?? '',
    matchedBy: 'manual',
    ...(lineageManualLinkKind(link) === 'pr' && link.number !== undefined
      ? {
          pr: {
            number: link.number,
            ...(link.url ? { url: link.url } : {}),
            ...providerOf(link.url)
          }
        }
      : {}),
    manualLinkId: link.id,
    reasons: [MANUAL_REASON]
  }
}

/**
 * Resolves manual links to members, mapping each to a local worktree when one exists.
 * invariant: local repos reuse the pattern scan's per-repo worktree list (same cache); SSH repos are never scanned.
 */
export async function resolveManualLinkMembers(
  links: LineageManualLink[],
  repos: PatternRepo[],
  options: ListRepoWorktreesOptions
): Promise<LineageMember[]> {
  const scans = new Map<string, Promise<GitWorktreeInfo[]>>()
  const scanFor = (repo: PatternRepo): Promise<GitWorktreeInfo[]> => {
    const existing = scans.get(repo.id)
    if (existing) {
      return existing
    }
    const scan = listRepoWorktrees(repo, options)
    scans.set(repo.id, scan)
    return scan
  }

  return Promise.all(
    links.map(async (link): Promise<LineageMember> => {
      const repo = findRepo(repos, link)
      const member = baseMember(link, repo)
      if (!repo || !wantsLocalWorktree(link)) {
        return member
      }
      if (repo.connectionId) {
        // hazard: an SSH worktree lives on its host; keep it as named, flagged unverifiable, never local-checked
        if (lineageManualLinkKind(link) === 'worktree' && link.worktreePath) {
          return {
            ...member,
            worktreePath: link.worktreePath,
            worktreeId: link.worktreeId ?? `${repo.id}${WORKTREE_ID_SEPARATOR}${link.worktreePath}`,
            unverifiable: true
          }
        }
        return member
      }
      const worktree = findWorktree(link, await scanFor(repo))
      if (!worktree) {
        // why: a removed worktree keeps its path (no id) only so its compact row can name the folder
        return lineageManualLinkKind(link) === 'worktree' && link.worktreePath
          ? { ...member, worktreePath: link.worktreePath }
          : member
      }
      return {
        ...member,
        branch: worktreeBranchName(worktree),
        worktreePath: worktree.path,
        worktreeId: `${repo.id}${WORKTREE_ID_SEPARATOR}${worktree.path}`
      }
    })
  )
}
