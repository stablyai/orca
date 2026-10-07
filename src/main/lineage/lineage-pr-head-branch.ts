import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { ParsedPullRequestReference } from '../../shared/lineage-pr-reference'
import type { PatternRepo } from './lineage-name-pattern-discovery'

export const LINEAGE_PR_LOOKUP_TIMEOUT_MS = 5000

export type LineagePullRequestLookup = Pick<
  ParsedPullRequestReference,
  'repoName' | 'number' | 'provider' | 'owner' | 'host'
>

async function lookupGitHub(
  repo: PatternRepo,
  pr: LineagePullRequestLookup
): Promise<string | null> {
  const { getWorkItem, getWorkItemByOwnerRepo } = await import('../github/client')
  // hazard: a URL may name another owner's same-named repo; only a configured remote of this repo may answer
  const item = pr.owner
    ? await getWorkItemByOwnerRepo(
        repo.path,
        { owner: pr.owner, repo: pr.repoName, ...(pr.host ? { host: pr.host } : {}) },
        pr.number,
        'pr'
      )
    : await getWorkItem(repo.path, pr.number, 'pr')
  return item?.type === 'pr' ? (item.branchName ?? null) : null
}

async function lookupGitLab(
  repo: PatternRepo,
  pr: LineagePullRequestLookup
): Promise<string | null> {
  const { getProjectSlug } = await import('../gitlab/merge-request-lookup')
  const { getWorkItemByProjectRef } = await import('../gitlab/work-item-queries')
  const projectRef = await getProjectSlug(repo.path)
  if (!projectRef) {
    return null
  }
  // hazard: a URL for another project with the same name must not borrow this repo's MR of that number
  if (pr.owner) {
    const wanted = `${pr.owner}/${pr.repoName}`.toLowerCase()
    const sameHost = !pr.host || !projectRef.host || pr.host === projectRef.host.toLowerCase()
    if (!sameHost || projectRef.path.toLowerCase() !== wanted) {
      return null
    }
  }
  const item = await getWorkItemByProjectRef(repo.path, projectRef, pr.number, 'mr')
  return item?.branchName ?? null
}

async function lookup(repo: PatternRepo, pr: LineagePullRequestLookup): Promise<string | null> {
  // why: lazy imports keep the provider clients out of every lineage IPC import graph
  const provider =
    pr.provider ??
    (
      await (
        await import('../source-control/forge-provider')
      ).getForgeProviderForRepository({
        repoPath: repo.path,
        executionHostId: LOCAL_EXECUTION_HOST_ID
      })
    )?.id
  if (provider === 'github') {
    return lookupGitHub(repo, pr)
  }
  if (provider === 'gitlab') {
    return lookupGitLab(repo, pr)
  }
  return null
}

/** Best-effort head branch of a pull/merge request, resolved once when it is added to a tower. */
export async function lookupLineagePullRequestHeadBranch(
  repo: PatternRepo,
  pr: LineagePullRequestLookup
): Promise<string | null> {
  // hazard: SSH repos must query from their execution host; the tower add stays local-only
  if (repo.connectionId) {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LINEAGE_PR_LOOKUP_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([lookup(repo, pr).catch(() => null), timeout])
  } finally {
    clearTimeout(timer)
  }
}
