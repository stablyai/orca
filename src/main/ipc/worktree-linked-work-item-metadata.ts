import type { Worktree, WorktreeMeta } from '../../shared/types'

type LinkedWorkItemMetadata = Pick<
  Worktree,
  | 'linkedIssueSourcePreference'
  | 'linkedGitLabMR'
  | 'linkedGitLabIssue'
  | 'linkedGitLabProjectRef'
  | 'linkedJiraIssue'
  | 'linkedJiraIssueSiteId'
  | 'linkedBitbucketPR'
  | 'linkedAzureDevOpsPR'
  | 'linkedGiteaPR'
>

export function getLinkedWorkItemMetadata(meta: WorktreeMeta | undefined): LinkedWorkItemMetadata {
  return {
    linkedJiraIssue: meta?.linkedJiraIssue ?? null,
    linkedJiraIssueSiteId: meta?.linkedJiraIssueSiteId ?? null,
    linkedIssueSourcePreference: meta?.linkedIssueSourcePreference ?? null,
    linkedGitLabMR: meta?.linkedGitLabMR ?? null,
    linkedGitLabIssue: meta?.linkedGitLabIssue ?? null,
    linkedGitLabProjectRef: meta?.linkedGitLabProjectRef ?? null,
    linkedBitbucketPR: meta?.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: meta?.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: meta?.linkedGiteaPR ?? null
  }
}
