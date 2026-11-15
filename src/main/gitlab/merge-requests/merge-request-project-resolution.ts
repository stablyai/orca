import type { IssueSourcePreference } from '../../../shared/repo-types'
import { getGlabKnownHosts, type LocalGitExecOptions } from '../projects/gitlab-known-host-probe'
import { resolveIssueSource } from '../issues/gitlab-issue-source-resolution'
import type { ProjectRef } from '../projects/project-ref-parser'

export async function withProjectRef<T>(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId: string | null | undefined,
  explicitProjectRef: ProjectRef | null | undefined,
  fn: (projectRef: ProjectRef, repoFlag: string) => Promise<T>,
  fallback: T,
  localGitOptions: LocalGitExecOptions = {}
): Promise<T> {
  const projectRef =
    explicitProjectRef ??
    (
      await resolveIssueSource(
        repoPath,
        preference,
        await getGlabKnownHosts(connectionId, localGitOptions),
        connectionId,
        localGitOptions
      )
    ).source
  if (!projectRef) {
    return fallback
  }
  return fn(projectRef, projectRef.path)
}
