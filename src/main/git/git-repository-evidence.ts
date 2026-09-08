import type { GitOperationSelector } from '../../shared/git-operation-selector'
import type { GitRemoteTopologySnapshot } from './git-remote-topology-snapshot'
import type { GitRemoteRoleProvenance, GitRemoteRoleResolution } from './git-operation-remote-roles'

export type GitRepositoryEvidence<T> =
  | { kind: 'verified'; repository: T }
  | { kind: 'non-provider' }
  | { kind: 'unverifiable' }

export type GitRepositoryRole<T> =
  | {
      kind: 'resolved'
      repository: T
      selector: GitOperationSelector
      direction: 'fetch' | 'push'
      provenance: GitRemoteRoleProvenance
      confidence: 'tracked' | 'inferred'
    }
  | { kind: 'ambiguous'; remoteNames: string[] }
  | { kind: 'unverifiable'; remoteNames: string[] }
  | { kind: 'unresolved' }

export type GitRemoteRepositories<T> = {
  selectors: Map<string, { fetch: GitRepositoryEvidence<T>; push: GitRepositoryEvidence<T>[] }>
  fetch: Map<string, GitRepositoryEvidence<T>>
  push: Map<string, GitRepositoryEvidence<T>[]>
}

// Identity belongs to a captured URL, never to a separately cached remote name.
export async function resolveSnapshotRepositories<T>(
  snapshot: GitRemoteTopologySnapshot,
  resolveUrl: (url: string) => Promise<GitRepositoryEvidence<T>>
): Promise<GitRemoteRepositories<T>> {
  const urls = new Map<string, Promise<GitRepositoryEvidence<T>>>()
  const resolve = (url: string): Promise<GitRepositoryEvidence<T>> => {
    let result = urls.get(url)
    if (!result) {
      result = resolveUrl(url).catch(() => ({ kind: 'unverifiable' as const }))
      urls.set(url, result)
    }
    return result
  }
  const fetch = new Map<string, GitRepositoryEvidence<T>>()
  const push = new Map<string, GitRepositoryEvidence<T>[]>()
  await Promise.all(
    snapshot.remoteNames.map(async (name) => {
      const url = snapshot.fetchUrls.get(name)
      fetch.set(name, url ? await resolve(url) : { kind: 'non-provider' })
      push.set(name, await Promise.all((snapshot.pushUrls.get(name) ?? []).map(resolve)))
    })
  )
  const selectors: GitRemoteRepositories<T>['selectors'] = new Map()
  for (const [value, endpoints] of snapshot.selectorEndpoints ?? []) {
    selectors.set(value, {
      fetch: await resolve(endpoints.fetch),
      push: await Promise.all(endpoints.push.map(resolve))
    })
  }
  return { fetch, push, selectors }
}

export function plausibleRepositoryRemotes<T>(
  evidence: Map<string, GitRepositoryEvidence<T>>
): string[] {
  return [...evidence].filter(([, value]) => value.kind !== 'non-provider').map(([name]) => name)
}

export function bindRepositoryRole<T>(
  role: GitRemoteRoleResolution,
  repositories: GitRemoteRepositories<T>,
  direction: 'fetch' | 'push'
): GitRepositoryRole<T> {
  if (role.kind !== 'resolved') {
    return role
  }
  const value = role.selector.value
  const literal = role.selector.kind === 'literal-url'
  const evidence = literal
    ? direction === 'fetch'
      ? [
          repositories.selectors.get(value)?.fetch ?? {
            kind: 'unverifiable' as const
          }
        ]
      : (repositories.selectors.get(value)?.push ?? [])
    : direction === 'fetch'
      ? [repositories.fetch.get(value) ?? { kind: 'unverifiable' as const }]
      : (repositories.push.get(value) ?? [])
  if (evidence.length > 1) {
    return { kind: 'ambiguous', remoteNames: [value] }
  }
  const identity = evidence[0]
  if (!identity || identity.kind === 'unverifiable') {
    return { kind: 'unverifiable', remoteNames: [value] }
  }
  if (identity.kind === 'non-provider') {
    return { kind: 'unresolved' }
  }
  return {
    ...role,
    repository: identity.repository,
    direction,
    confidence:
      role.provenance === 'configured-upstream' || role.provenance === 'persisted-exact-remote'
        ? 'tracked'
        : 'inferred'
  }
}
