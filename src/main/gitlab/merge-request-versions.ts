import {
  acquire,
  getGlabKnownHosts,
  getProjectRef,
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  release
} from './gl-utils'
import { encodedProject } from './project-path-encoding'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'

/**
 * Every head the merge request's source branch has had: GitLab records one diff version per push,
 * including its own "Apply suggestion" and "Rebase" commits. Newest 100 only; an older head reads
 * as absent.
 */
export async function getMergeRequestVersionHeadShas(
  repoPath: string,
  iid: number,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<string[]> {
  const localGitOptions = getHostedReviewLocalGitOptions(options)
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const projectRef = await getProjectRef(repoPath, knownHosts, connectionId, localGitOptions)
  if (!projectRef) {
    return []
  }
  await acquire()
  try {
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/versions?per_page=100`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const versions: unknown = JSON.parse(stdout)
    if (!Array.isArray(versions)) {
      return []
    }
    return versions.flatMap((version: { head_commit_sha?: unknown } | null) =>
      typeof version?.head_commit_sha === 'string' ? [version.head_commit_sha] : []
    )
  } finally {
    release()
  }
}
