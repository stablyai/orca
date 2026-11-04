import { parseRemoteProjectRefCandidate } from '../../main/gitlab/project-ref-parser'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import { parseGitLabIssueOrMRLink, type ProjectSlug } from '../../shared/new-workspace/gitlab-links'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import type { CliRepoTarget } from '../worktree-project-target'

export async function assertGitLabLinkFlagProjectsMatch(
  flags: Map<string, string | boolean>,
  client: RuntimeClient,
  target: CliRepoTarget | { worktree: string }
): Promise<void> {
  const projects = ['gitlab-issue', 'gitlab-mr'].flatMap((name) => {
    const value = flags.get(name)
    const link =
      typeof value === 'string' && /^https?:\/\//i.test(value.trim())
        ? parseGitLabIssueOrMRLink(value)
        : null
    return link ? [link.slug] : []
  })
  if (projects.length === 0) {
    return
  }

  let project: ProjectSlug | null = null
  let repoTarget: CliRepoTarget
  if ('worktree' in target) {
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', target)
    const context = result.result.worktree.linkedTaskSourceContext
    const identity = context?.providerIdentity
    if (context?.provider === 'gitlab' && identity?.provider === 'gitlab' && identity.webUrl) {
      project = parseRemoteProjectRefCandidate(identity.webUrl)
    }
    repoTarget = { repo: `id:${result.result.worktree.repoId}` }
  } else {
    repoTarget = target
  }
  if (!project) {
    const result = await client.call<{ repo: Repo }>('repo.show', repoTarget)
    const remoteUrl = result.result.repo.gitRemoteIdentity?.remoteUrl
    project = remoteUrl ? parseRemoteProjectRefCandidate(remoteUrl) : null
  }

  // Numeric slots cannot retain a pasted URL's foreign host or project.
  if (
    !project ||
    projects.some((link) => link.host !== project.host || link.path !== project.path)
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The GitLab URL must match the workspace source project or the repository’s stored remote. Use a number for an item in that project; URLs cannot choose a different project.'
    )
  }
}
