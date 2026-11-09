// A chat that publishes its checkout under a new remote branch name (`git push origin HEAD:other`)
// leaves the local branch tracking its old name; record the new one so the workspace keeps its PR.

import { iterateProcessOutputLines } from '../../../shared/process-output-field-scanner'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import type { GitHubOwnerRepo } from '../../../shared/github/pull-request-types'
import {
  parseGitRemoteFetchUrls,
  parseGitRemoteVerboseLine,
  findGitRemoteNameByPushedUrl
} from '../../../shared/git/remotes/git-remote-url-index'
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments/workspace-attachments'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  HOSTED_REVIEW_LINK_KEYS,
  type HostedReviewLinkKey
} from '../../../shared/worktree/hosted-review-links'
import type { WorkspaceAttachment, GitPushTarget } from '../../../shared/worktree/types'
import type { PRPublishedBranch } from '../../github/pr-watch/pr-watch-types'

type GitExec = (args: string[]) => Promise<{ stdout: string }>

export type PublishedBranchWorkspace = { git: { branch: string } } & Pick<
  WorktreeMeta,
  HostedReviewLinkKey | 'pushTarget' | 'linkedItems' | 'suppressedGitHubPR'
>

export async function adoptPublishedPRBranch(args: {
  worktree: PublishedBranchWorkspace
  published: PRPublishedBranch
  execGit: GitExec
  /** The GitHub repository a configured remote names, github.com or an authenticated Enterprise host. */
  resolveRemote: (remoteName: string) => Promise<GitHubOwnerRepo | null>
  /** The repository a separate `pushurl` names; only compared, never contacted. */
  resolvePushUrl: (pushUrl: string) => Promise<GitHubOwnerRepo | null>
  update: (
    updates: {
      pushTarget: GitPushTarget
      linkedPR: number
      linkedItems: WorkspaceAttachment[]
    },
    validateCheckout: () => Promise<boolean>
  ) => Promise<unknown>
}): Promise<void> {
  const { worktree, published, execGit } = args
  const { pushTarget } = worktree
  const branch = worktree.git.branch.replace(/^refs\/heads\//u, '')
  if (
    // A detached checkout has no branch to follow, and a switched one is the user's choice.
    branch !== published.checkoutBranch.replace(/^refs\/heads\//u, '') ||
    worktree.suppressedGitHubPR === published.pr.number ||
    // Never displace a fork target or a PR the workspace already names.
    (pushTarget && pushTarget.branchName !== published.branch) ||
    HOSTED_REVIEW_LINK_KEYS.some((key) => worktree[key] != null)
  ) {
    return
  }
  const remoteName = await execGit(['remote', '-v']).then(async ({ stdout }) => {
    if (published.remoteUrl) {
      return findGitRemoteNameByPushedUrl(stdout, published.remoteUrl, pushTarget?.remoteName)
    }
    if (!published.headRepo) {
      return null
    }
    const fetchUrls = parseGitRemoteFetchUrls(stdout)
    for (const line of iterateProcessOutputLines(stdout)) {
      const entry = parseGitRemoteVerboseLine(line)
      if (entry?.direction !== 'push' || (pushTarget && entry.name !== pushTarget.remoteName)) {
        continue
      }
      // A remote that fetches upstream but pushes to a fork names the fork only in its pushurl.
      const repository =
        fetchUrls.get(entry.name) === entry.url
          ? await args.resolveRemote(entry.name)
          : await args.resolvePushUrl(entry.url)
      if (
        repository &&
        githubRepoIdentityKey(repository) === githubRepoIdentityKey(published.headRepo)
      ) {
        return entry.name
      }
    }
    return null
  })
  const validateCheckout = async () => {
    const { stdout } = await execGit(['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'])
    const [head, ref, ...extra] = stdout.trim().split(/\r?\n/u)
    return head === published.headSha && ref === `refs/heads/${branch}` && extra.length === 0
  }
  // Only the checkout's own HEAD follows; a push of another commit says nothing about this branch.
  if (!remoteName || !(await validateCheckout())) {
    return
  }
  const url = `https://${published.pr.host}/${published.pr.owner}/${published.pr.repo}/pull/${published.pr.number}`
  await args.update(
    {
      pushTarget: pushTarget ?? { remoteName, branchName: published.branch },
      linkedPR: published.pr.number,
      linkedItems: [
        {
          provider: 'github',
          type: 'pr',
          number: published.pr.number,
          url
        },
        ...getWorkspaceAttachments(worktree).filter(
          (item) =>
            !(
              item.provider === 'github' &&
              item.type === 'pr' &&
              item.number === published.pr.number &&
              (!item.url || item.url === url)
            )
        )
      ]
    },
    validateCheckout
  )
}
