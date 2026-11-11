import type { GitReviewBranchSource } from '../../shared/git/remotes/git-review-branch-source'
import { parseRemoteProjectRefCandidate, normalizeGitLabHost } from './project-ref-parser'
import { isUnresolvedSshHostAlias } from '../../shared/git/remotes/git-remote-host-alias'
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
  const projects: ProjectRef[] = []
  for (const url of args.urls) {
    const candidate = parseRemoteProjectRefCandidate(url)
    if (!candidate) {
      throw new Error('Review source is unavailable')
    }
    const http = /^https?:\/\//i.test(url.trim())
    const targetHost = normalizeGitLabHost(args.target.host)
    const matches =
      normalizeGitLabHost(candidate.host) === (http ? targetHost : targetHost.replace(/:\d+$/, ''))
    if (!matches) {
      if (!http && isUnresolvedSshHostAlias(candidate.host)) {
        throw new Error('Review source alias is unresolved')
      }
      continue
    }
    projects.push({ host: args.target.host, path: candidate.path })
  }
  for (const project of projects) {
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
    source ??= { project: { ...project, path: identity.path }, id: identity.id }
  }
  if (!source) {
    throw new Error('Review source is unavailable')
  }
  return source
}
