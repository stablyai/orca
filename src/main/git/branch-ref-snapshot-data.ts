import type { BaseRefSearchResult } from '../../shared/repo-types'
import { branchRefLabel } from '../../shared/git/refs/branch-ref-label'
import { isSafeGitRefName } from '../../shared/git/status/git-status-upstream-ref'
import { isRemoteHeadRef } from '../../shared/source-control/hosted-review/hosted-review-refs'

export type BranchRef = {
  refName: string
  oid: string
  committedAt: number
  symref: string
  label: string
  searchName: string
}

export const BRANCH_REF_SNAPSHOT_ARGS = [
  'for-each-ref',
  '--sort=refname',
  '--sort=-committerdate',
  '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(symref)',
  'refs/heads',
  'refs/remotes'
]

export function parseBranchRef(line: string): BranchRef | null {
  const [refName, oid, timestamp, symref = ''] = line.replace(/\r$/, '').split('\0')
  if (!refName || !oid || !isSafeGitRefName(refName) || !/^refs\/(heads|remotes)\//.test(refName)) {
    return null
  }
  const label = branchRefLabel(refName)
  return {
    refName,
    oid,
    committedAt: Number.isFinite(Number(timestamp)) ? Number(timestamp) * 1000 : 0,
    symref,
    label,
    searchName: label.toLowerCase()
  }
}

export function resolveConfiguredRemoteBranchName(
  fullRef: string,
  longestFirstRemoteNames: readonly string[]
): string | null {
  if (!fullRef.startsWith('refs/remotes/')) {
    return null
  }
  const remoteAndBranch = fullRef.slice('refs/remotes/'.length)
  const remote = longestFirstRemoteNames.find((name) => remoteAndBranch.startsWith(`${name}/`))
  return remote ? remoteAndBranch.slice(remote.length + 1) || null : null
}

export function resolveLocalBranchName(
  fullRef: string,
  fallback: string,
  remotes: string[]
): string {
  if (fullRef.startsWith('refs/heads/')) {
    return fullRef.slice('refs/heads/'.length) || fallback
  }
  if (!fullRef.startsWith('refs/remotes/')) {
    return fallback
  }
  return (
    (resolveConfiguredRemoteBranchName(fullRef, remotes) ??
      fullRef.slice('refs/remotes/'.length).split('/').slice(1).join('/')) ||
    fallback
  )
}

export function matchesBranchRef(ref: BranchRef, query: string, remoteOnly: boolean): boolean {
  return (!remoteOnly || ref.refName.startsWith('refs/remotes/')) && ref.searchName.includes(query)
}

export function projectBranchRefs(
  refs: Iterable<BranchRef>,
  remotes: string[],
  query: string,
  limit: number,
  remoteOnly = false,
  legacySelectors?: ReadonlyMap<string, string>
): BaseRefSearchResult[] {
  const results: BaseRefSearchResult[] = []
  const project = createBranchRefProjection(remotes, query, remoteOnly, legacySelectors)
  for (const ref of refs) {
    const result = project(ref)
    if (result) {
      results.push(result)
    }
    if (results.length >= limit) {
      break
    }
  }
  return results
}

export function createBranchRefProjection(
  remotes: string[],
  query: string,
  remoteOnly = false,
  legacySelectors?: ReadonlyMap<string, string>
): (ref: BranchRef) => BaseRefSearchResult | null {
  const normalized = query
    .trim()
    .replace(/[*?[\]\\]/g, '')
    .toLowerCase()
  const longestFirst = [...remotes].sort((left, right) => right.length - left.length)
  return (ref) => {
    if (
      !matchesBranchRef(ref, normalized, remoteOnly) ||
      isRemoteHeadRef(ref.refName, longestFirst)
    ) {
      return null
    }
    const refName = legacySelectors ? legacySelectors.get(ref.refName) : ref.refName
    if (!refName || (legacySelectors && refName.startsWith('refs/'))) {
      return null
    }
    return {
      refName,
      localBranchName: resolveLocalBranchName(ref.refName, ref.label, longestFirst)
    }
  }
}
