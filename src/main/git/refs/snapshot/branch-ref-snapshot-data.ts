import type { BaseRefSearchResult } from '../../../../shared/repository/repo-types'
import { branchRefLabel } from '../../../../shared/git/refs/branch-ref-label'
import { getRefSearchTokens } from '../../../../shared/git/refs/ref-search-tokens'
import { isSafeGitRefName } from '../../../../shared/git/status/git-status-upstream-ref'
import { isRemoteHeadRef } from '../../../../shared/source-control/hosted-review/hosted-review-refs'

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

// Substring match, or tokens matched per segment (git `*` never crosses `/`): without an edge
// slash the ref has one segment per token; an edge slash requires a further segment on that side.
function createBranchRefMatcher(query: string): (searchName: string) => boolean {
  const tokens = getRefSearchTokens(query)
  const leading = query.startsWith('/')
  const trailing = query.endsWith('/')
  const segmented = tokens.length > 1 || (tokens.length === 1 && (leading || trailing))
  const matchesAt = (segments: string[], start: number): boolean =>
    tokens.every((token, index) => segments[start + index].includes(token))
  return (searchName) => {
    if (searchName.includes(query)) {
      return true
    }
    if (!segmented) {
      return false
    }
    const segments = searchName.split('/')
    const lastStart = segments.length - tokens.length - (trailing ? 1 : 0)
    if (!leading && !trailing) {
      return lastStart === 0 && matchesAt(segments, 0)
    }
    for (let start = leading ? 1 : 0; start <= lastStart; start += 1) {
      if (matchesAt(segments, start)) {
        return true
      }
    }
    return false
  }
}

export function projectBranchRefs(
  refs: Iterable<BranchRef>,
  remotes: string[],
  query: string,
  limit: number,
  remoteOnly = false
): BaseRefSearchResult[] {
  const results: BaseRefSearchResult[] = []
  const project = createBranchRefProjection(remotes, query, remoteOnly)
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
  remoteOnly = false
): (ref: BranchRef) => BaseRefSearchResult | null {
  const normalized = query
    .trim()
    .replace(/[*?[\]\\]/g, '')
    .toLowerCase()
  const matches = createBranchRefMatcher(normalized)
  const longestFirst = [...remotes].sort((left, right) => right.length - left.length)
  return (ref) => {
    if (
      (remoteOnly && !ref.refName.startsWith('refs/remotes/')) ||
      !matches(ref.searchName) ||
      isRemoteHeadRef(ref.refName, longestFirst)
    ) {
      return null
    }
    return {
      refName: ref.refName,
      localBranchName: resolveLocalBranchName(ref.refName, ref.label, longestFirst)
    }
  }
}
