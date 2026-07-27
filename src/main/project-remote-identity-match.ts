import { getProjectIdentityKey } from '../shared/project-host-setup-projection'
import type { GitRemoteIdentity } from '../shared/git-remote-identity'
import type { Project, Repo } from '../shared/types'

/** `git:`-sourced keys compare byte-for-byte (path case is significant on generic git
 *  servers); provider-derived keys compare case-insensitively because
 *  `githubRepoIdentityKey` lowercases the slug while `normalizeGitRemoteUrl` does not. */
type ProjectCanonicalKey = { key: string; caseSensitive: boolean }

export type ProjectRemoteMatch = {
  canonicalKeys: ProjectCanonicalKey[]
  /** The key the project itself projects to. Running a remote through the same
   *  builder folds spellings the literal keys cannot: GHES endpoint ports, which
   *  `parseGitHubRemoteUrl` keeps and `normalizeGitRemoteUrl` drops, and the
   *  `ssh.github.com` alias. `null` when the project has no identity at all. */
  identityKey: string | null
}

export function projectRemoteMatch(project: Project): ProjectRemoteMatch {
  const canonicalKeys: ProjectCanonicalKey[] = []
  const gitKey = project.gitRemoteIdentity?.canonicalKey?.trim()
  if (gitKey) {
    canonicalKeys.push({ key: gitKey, caseSensitive: true })
  }
  const identity = project.providerIdentity
  const owner = identity?.owner.trim()
  const repo = identity?.repo.trim()
  if (owner && repo) {
    // Strip the GHES endpoint port: `normalizeGitRemoteUrl` keys every remote off the
    // hostname, so a ported provider host could never match a probed remote at all.
    const host = (identity?.host?.trim() || 'github.com').replace(/:\d+$/, '')
    canonicalKeys.push({ key: `${host}/${owner}/${repo}`, caseSensitive: false })
  }
  const identityKey = getProjectIdentityKey({
    id: '',
    ...(identity ? { upstream: identity } : {}),
    ...(project.gitRemoteIdentity ? { gitRemoteIdentity: project.gitRemoteIdentity } : {})
  })
  return { canonicalKeys, identityKey: identityKey.startsWith('repo:') ? null : identityKey }
}

export function matchesProject(remote: GitRemoteIdentity, match: ProjectRemoteMatch): boolean {
  const matchesLiteralKey = match.canonicalKeys.some((entry) =>
    entry.caseSensitive
      ? entry.key === remote.canonicalKey
      : entry.key.toLowerCase() === remote.canonicalKey.toLowerCase()
  )
  return (
    matchesLiteralKey ||
    (match.identityKey !== null &&
      getProjectIdentityKey({ id: '', gitRemoteIdentity: remote }) === match.identityKey)
  )
}

export function isSameRemoteIdentity(
  stored: Repo['gitRemoteIdentity'],
  candidate: Repo['gitRemoteIdentity']
): boolean {
  if (!stored || !candidate) {
    return stored === candidate
  }
  return (
    stored.canonicalKey === candidate.canonicalKey &&
    stored.remoteName === candidate.remoteName &&
    stored.remoteUrl === candidate.remoteUrl
  )
}

export function isSameUpstream(stored: Repo['upstream'], candidate: Repo['upstream']): boolean {
  if (!stored || !candidate) {
    return stored === candidate
  }
  return (
    stored.owner === candidate.owner &&
    stored.repo === candidate.repo &&
    (stored.host ?? null) === (candidate.host ?? null)
  )
}
