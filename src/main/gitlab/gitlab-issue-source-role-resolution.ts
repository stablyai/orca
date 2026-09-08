import { resolveIssueSourceRole } from '../git/git-operation-remote-roles'
import { getGitRemoteTopologySnapshot } from '../git/git-remote-topology-snapshot'
import {
  resolveSnapshotRepositories,
  plausibleRepositoryRemotes,
  bindRepositoryRole,
  type GitRepositoryEvidence
} from '../git/git-repository-evidence'
import type { ProjectRef } from './project-ref-parser'

export type GitLabIssueSourceRoleResult = {
  source: ProjectRef | null
  fellBack: false
  ambiguousRemoteNames?: string[]
}

export async function resolveGitLabIssueSourceRole(args: {
  repoPath: string
  knownHosts: readonly string[]
  connectionId?: string | null
  localGitOptions?: { wslDistro?: string }
  resolveUrl: (url: string) => Promise<GitRepositoryEvidence<ProjectRef>>
}): Promise<GitLabIssueSourceRoleResult> {
  const snapshot = await getGitRemoteTopologySnapshot(args)
  const repositories = await resolveSnapshotRepositories(snapshot, args.resolveUrl)
  const plausible = plausibleRepositoryRemotes(repositories.fetch)
  const role = bindRepositoryRole(resolveIssueSourceRole(plausible), repositories, 'fetch')
  if (role.kind === 'resolved') {
    return { source: role.repository, fellBack: false }
  }
  return {
    source: null,
    fellBack: false,
    ...(role.kind === 'ambiguous' || role.kind === 'unverifiable'
      ? { ambiguousRemoteNames: role.remoteNames }
      : {})
  }
}
