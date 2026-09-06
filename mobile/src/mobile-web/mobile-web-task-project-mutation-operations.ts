import {
  MobileWebTaskProjectCommentAddPayloadSchema,
  MobileWebTaskProjectCommentAddResultSchema,
  MobileWebTaskProjectCommentDeletePayloadSchema,
  MobileWebTaskProjectCommentUpdatePayloadSchema,
  MobileWebTaskProjectConversationCommentPayloadSchema,
  MobileWebTaskProjectFieldUpdatePayloadSchema,
  MobileWebTaskProjectIssueTypeUpdatePayloadSchema,
  MobileWebTaskProjectItemUpdatePayloadSchema,
  MobileWebTaskProjectMergePayloadSchema,
  MobileWebTaskProjectMetadataUpdatePayloadSchema,
  MobileWebTaskProjectMutationResultSchema,
  MobileWebTaskProjectRerunChecksPayloadSchema,
  MobileWebTaskProjectReviewersPayloadSchema,
  MobileWebTaskProjectReviewReplyPayloadSchema,
  MobileWebTaskProjectReviewThreadPayloadSchema
} from '../../../src/shared/mobile-web/task-project-mutation-contract'
import type { MobileWebTaskProjectTable } from '../../../src/shared/mobile-web/task-project-table-contract'
import type {
  HostTaskProjectFieldTarget,
  HostTaskProjectItemTarget
} from '../tasks/host-task-project-mutation-operations'
import { nativeHostTaskProjectMutationOperations } from '../tasks/native-host-task-project-mutation-operations'
import { nativeHostTaskProjectReadOperations } from '../tasks/native-host-task-project-read-operations'
import { nativeHostTaskReadOperations } from '../tasks/native-host-task-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type {
  MobileWebGitHubProjectTaskTarget,
  MobileWebTaskTargetAuthority
} from './mobile-web-task-target-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const OPERATIONS = new Set([
  'updateProjectItem',
  'addProjectComment',
  'updateProjectComment',
  'deleteProjectComment',
  'updateProjectMetadata',
  'updateProjectField',
  'updateProjectIssueType',
  'resolveProjectReviewThread',
  'replyProjectReviewComment',
  'addProjectConversationComment',
  'requestProjectReviewers',
  'rerunProjectChecks',
  'mergeProjectPullRequest'
])

export async function executeMobileWebTaskProjectMutationOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  targetAuthority: MobileWebTaskTargetAuthority
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<{ handled: boolean; result?: unknown }> {
  if (!OPERATIONS.has(args.operation)) {
    return { handled: false }
  }
  const targetId = readTargetId(args.operation, args.payload)
  const target = args.targetAuthority.resolveGitHubProject(targetId)
  const fresh = await revalidateProjectTarget(args.client, target)
  args.targetAuthority.assertGitHubProjectTarget(targetId, target)
  const operations = nativeHostTaskProjectMutationOperations(args.client)
  if (args.operation === 'updateProjectItem') {
    const payload = MobileWebTaskProjectItemUpdatePayloadSchema.parse(args.payload)
    await operations.updateItem(fresh.item, payload.updates)
    return done()
  }
  if (args.operation === 'addProjectComment') {
    const payload = MobileWebTaskProjectCommentAddPayloadSchema.parse(args.payload)
    const comment = await operations.addComment(fresh.item, payload.body)
    return {
      handled: true,
      result: MobileWebTaskProjectCommentAddResultSchema.parse({ comment })
    }
  }
  if (args.operation === 'updateProjectComment') {
    const payload = MobileWebTaskProjectCommentUpdatePayloadSchema.parse(args.payload)
    await operations.updateComment(fresh.item, payload.commentId, payload.body)
    return done()
  }
  if (args.operation === 'deleteProjectComment') {
    const payload = MobileWebTaskProjectCommentDeletePayloadSchema.parse(args.payload)
    await operations.deleteComment(fresh.item, payload.commentId)
    return done()
  }
  if (args.operation === 'updateProjectMetadata') {
    const payload = MobileWebTaskProjectMetadataUpdatePayloadSchema.parse(args.payload)
    await operations.updateMetadata(fresh.item, payload.updates)
    return done()
  }
  if (args.operation === 'updateProjectField') {
    const payload = MobileWebTaskProjectFieldUpdatePayloadSchema.parse(args.payload)
    requireProjectField(fresh.table, payload.fieldId)
    await operations.updateField(fresh.field, payload.fieldId, payload.value)
    return done()
  }
  if (args.operation === 'updateProjectIssueType') {
    const payload = MobileWebTaskProjectIssueTypeUpdatePayloadSchema.parse(args.payload)
    if (fresh.item.type !== 'issue') {
      throw new MobileWebBrokerError('invalid_request')
    }
    await operations.updateIssueType(fresh.item, payload.issueTypeId)
    return done()
  }
  const repoId = await revalidateProjectRepo(
    args.client,
    args.workspaceAuthority,
    readRepoId(args.operation, args.payload),
    fresh.item
  )
  args.targetAuthority.assertGitHubProjectTarget(targetId, target)
  if (fresh.item.type !== 'pr') {
    throw new MobileWebBrokerError('invalid_request')
  }
  if (args.operation === 'resolveProjectReviewThread') {
    const payload = MobileWebTaskProjectReviewThreadPayloadSchema.parse(args.payload)
    await operations.resolveReviewThread(fresh.item, repoId, payload.threadId, payload.resolve)
    return done()
  }
  if (args.operation === 'replyProjectReviewComment') {
    const payload = MobileWebTaskProjectReviewReplyPayloadSchema.parse(args.payload)
    await operations.replyReviewComment(fresh.item, repoId, {
      commentId: payload.commentId,
      body: payload.body,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
      ...(payload.path ? { path: payload.path } : {}),
      ...(payload.line ? { line: payload.line } : {})
    })
    return done()
  }
  if (args.operation === 'addProjectConversationComment') {
    const payload = MobileWebTaskProjectConversationCommentPayloadSchema.parse(args.payload)
    await operations.addConversationComment(fresh.item, repoId, payload.body)
    return done()
  }
  if (args.operation === 'requestProjectReviewers') {
    const payload = MobileWebTaskProjectReviewersPayloadSchema.parse(args.payload)
    await operations.requestReviewers(fresh.item, repoId, payload.reviewers)
    return done()
  }
  if (args.operation === 'rerunProjectChecks') {
    const payload = MobileWebTaskProjectRerunChecksPayloadSchema.parse(args.payload)
    await operations.rerunChecks(fresh.item, repoId, {
      ...(payload.headSha ? { headSha: payload.headSha } : {}),
      failedOnly: payload.failedOnly
    })
    return done()
  }
  if (args.operation === 'mergeProjectPullRequest') {
    const payload = MobileWebTaskProjectMergePayloadSchema.parse(args.payload)
    await operations.merge(fresh.item, repoId, payload.method)
    return done()
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

export async function revalidateProjectTarget(
  client: RpcClient,
  target: MobileWebGitHubProjectTaskTarget
): Promise<{
  item: HostTaskProjectItemTarget
  field: HostTaskProjectFieldTarget
  table: MobileWebTaskProjectTable
}> {
  const table = await nativeHostTaskProjectReadOperations(client).loadTable({
    owner: target.owner,
    host: target.host,
    ownerType: target.ownerType,
    number: target.projectNumber,
    viewId: target.viewId,
    queryOverride: target.queryOverride
  })
  const row = table.rows.find((candidate) => candidate.id === target.rowId)
  if (
    !row ||
    row.itemType !== target.itemType ||
    row.content.repository !== target.repository ||
    row.content.number !== target.number
  ) {
    throw new MobileWebBrokerError('not_found')
  }
  const slug = splitSlug(row.content.repository)
  const type = row.itemType === 'ISSUE' ? 'issue' : row.itemType === 'PULL_REQUEST' ? 'pr' : null
  if (!slug || !row.content.number || !type) {
    throw new MobileWebBrokerError('invalid_request')
  }
  const item: HostTaskProjectItemTarget = {
    owner: slug.owner,
    repo: slug.repo,
    host: target.host,
    number: row.content.number,
    type
  }
  return {
    item,
    field: { ...item, projectId: table.project.id, itemId: row.id },
    table
  }
}

function requireProjectField(table: MobileWebTaskProjectTable, fieldId: string): void {
  const fields = [
    ...table.selectedView.fields,
    ...table.selectedView.groupByFields,
    ...table.selectedView.sortByFields.map((sort) => sort.field)
  ]
  if (!fields.some((field) => field.id === fieldId)) {
    throw new MobileWebBrokerError('not_found')
  }
}

function readTargetId(operation: string, payload: unknown): string {
  const schema =
    operation === 'updateProjectItem'
      ? MobileWebTaskProjectItemUpdatePayloadSchema
      : operation === 'addProjectComment'
        ? MobileWebTaskProjectCommentAddPayloadSchema
        : operation === 'updateProjectComment'
          ? MobileWebTaskProjectCommentUpdatePayloadSchema
          : operation === 'deleteProjectComment'
            ? MobileWebTaskProjectCommentDeletePayloadSchema
            : operation === 'updateProjectMetadata'
              ? MobileWebTaskProjectMetadataUpdatePayloadSchema
              : operation === 'updateProjectField'
                ? MobileWebTaskProjectFieldUpdatePayloadSchema
                : operation === 'updateProjectIssueType'
                  ? MobileWebTaskProjectIssueTypeUpdatePayloadSchema
                  : operation === 'resolveProjectReviewThread'
                    ? MobileWebTaskProjectReviewThreadPayloadSchema
                    : operation === 'replyProjectReviewComment'
                      ? MobileWebTaskProjectReviewReplyPayloadSchema
                      : operation === 'addProjectConversationComment'
                        ? MobileWebTaskProjectConversationCommentPayloadSchema
                        : operation === 'requestProjectReviewers'
                          ? MobileWebTaskProjectReviewersPayloadSchema
                          : operation === 'rerunProjectChecks'
                            ? MobileWebTaskProjectRerunChecksPayloadSchema
                            : MobileWebTaskProjectMergePayloadSchema
  return schema.parse(payload).targetId
}

function readRepoId(operation: string, payload: unknown): string {
  const schema =
    operation === 'resolveProjectReviewThread'
      ? MobileWebTaskProjectReviewThreadPayloadSchema
      : operation === 'replyProjectReviewComment'
        ? MobileWebTaskProjectReviewReplyPayloadSchema
        : operation === 'addProjectConversationComment'
          ? MobileWebTaskProjectConversationCommentPayloadSchema
          : operation === 'requestProjectReviewers'
            ? MobileWebTaskProjectReviewersPayloadSchema
            : operation === 'rerunProjectChecks'
              ? MobileWebTaskProjectRerunChecksPayloadSchema
              : MobileWebTaskProjectMergePayloadSchema
  return schema.parse(payload).repoId
}

export async function revalidateProjectRepo(
  client: RpcClient,
  authority: MobileWebWorkspaceAuthority,
  pageRepoId: string,
  target: HostTaskProjectItemTarget
): Promise<string> {
  const hostRepoId = authority.hostRepoId(pageRepoId)
  const identity = await nativeHostTaskReadOperations(client).resolveGitHubRepoSlug(hostRepoId)
  if (
    !identity ||
    identity.owner !== target.owner ||
    identity.repo !== target.repo ||
    (identity.host ?? 'github.com') !== target.host
  ) {
    throw new MobileWebBrokerError('not_found')
  }
  authority.assertHostRepoBinding(pageRepoId, hostRepoId)
  return hostRepoId
}

function splitSlug(value: string | null): { owner: string; repo: string } | null {
  const segments = value?.split('/')
  return segments?.length === 2 && segments[0] && segments[1]
    ? { owner: segments[0], repo: segments[1] }
    : null
}

function done(): { handled: true; result: null } {
  return { handled: true, result: MobileWebTaskProjectMutationResultSchema.parse(null) }
}
