import type { MobileWebTaskDetailComment } from '../../../src/shared/mobile-web/task-detail-contract'
import type { MobileWebTaskProjectFieldMutationValue } from '../../../src/shared/mobile-web/task-project-table-contract'

export type HostTaskProjectItemTarget = {
  targetId?: string
  owner: string
  repo: string
  host: string
  number: number
  type: 'issue' | 'pr'
}

export type HostTaskProjectFieldTarget = HostTaskProjectItemTarget & {
  projectId: string
  itemId: string
}

export type HostTaskProjectMetadataUpdates = {
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

export type HostTaskProjectMutationOperations = {
  updateItem(
    target: HostTaskProjectItemTarget,
    updates: { title?: string; body?: string; state?: 'open' | 'closed' }
  ): Promise<void>
  addComment(
    target: HostTaskProjectItemTarget,
    body: string
  ): Promise<MobileWebTaskDetailComment | undefined>
  updateComment(target: HostTaskProjectItemTarget, commentId: number, body: string): Promise<void>
  deleteComment(target: HostTaskProjectItemTarget, commentId: number): Promise<void>
  updateMetadata(
    target: HostTaskProjectItemTarget,
    updates: HostTaskProjectMetadataUpdates
  ): Promise<void>
  updateField(
    target: HostTaskProjectFieldTarget,
    fieldId: string,
    value: MobileWebTaskProjectFieldMutationValue | null
  ): Promise<void>
  updateIssueType(target: HostTaskProjectItemTarget, issueTypeId: string | null): Promise<void>
  resolveReviewThread(
    target: HostTaskProjectItemTarget,
    repoId: string,
    threadId: string,
    resolve: boolean
  ): Promise<void>
  replyReviewComment(
    target: HostTaskProjectItemTarget,
    repoId: string,
    payload: {
      commentId: number
      body: string
      threadId?: string
      path?: string
      line?: number
    }
    // Why: the server comment carries the real id; a local stub id fails the numeric-id check
    // that routes a follow-up reply back to the same review thread.
  ): Promise<MobileWebTaskDetailComment | undefined>
  addConversationComment(
    target: HostTaskProjectItemTarget,
    repoId: string,
    body: string
  ): Promise<MobileWebTaskDetailComment | undefined>
  requestReviewers(
    target: HostTaskProjectItemTarget,
    repoId: string,
    reviewers: string[]
  ): Promise<void>
  rerunChecks(
    target: HostTaskProjectItemTarget,
    repoId: string,
    payload: { headSha?: string; failedOnly: boolean }
  ): Promise<void>
  merge(
    target: HostTaskProjectItemTarget,
    repoId: string,
    method: 'merge' | 'squash' | 'rebase'
  ): Promise<void>
}
