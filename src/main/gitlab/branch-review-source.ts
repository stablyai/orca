import type { GitReviewBranchSource } from '../../shared/git/remotes/git-review-branch-source'
import { parseGitLabProjectRef, normalizeGitLabHost } from './project-ref-parser'
import { readReviewProjectIdentity } from './review-project-identity'
import type { LocalGitExecOptions, ProjectRef } from './gl-utils'

export async function resolveReviewSourceProject(args: {
  repoPath: string
  target: ProjectRef
  urls: GitReviewBranchSource['urls']
  connectionId?: string | null
  localGitOptions: LocalGitExecOptions
  force?: boolean
}): Promise<{ project: ProjectRef; id: number }> {
  let source: { project: ProjectRef; id: number } | undefined
  const seen = new Set<string>()
  for (const url of args.urls) {
    const project = parseGitLabProjectRef(url, [args.target.host])
    if (!project || normalizeGitLabHost(project.host) !== normalizeGitLabHost(args.target.host)) {
      throw new Error('Review source is not on the target GitLab host')
    }
    const key = `${project.host}\0${project.path}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const identity = await readReviewProjectIdentity(
      args.repoPath,
      project,
      args.connectionId,
      args.localGitOptions,
      args.force
    )
    if (source && source.id !== identity.id) {
      throw new Error('Review source has multiple projects')
    }
    source ??= { project, id: identity.id }
  }
  if (!source) {
    throw new Error('Review source is unavailable')
  }
  return source
}
