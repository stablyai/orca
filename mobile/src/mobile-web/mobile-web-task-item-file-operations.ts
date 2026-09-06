import type { MobileWebTaskGitHubDetailResult } from '../../../src/shared/mobile-web/task-detail-contract'
import {
  MobileWebTaskItemChecksPayloadSchema,
  MobileWebTaskItemChecksResultSchema,
  MobileWebTaskItemFileContentsPayloadSchema,
  MobileWebTaskItemFileContentsResultSchema,
  MobileWebTaskItemFileMutationResultSchema,
  MobileWebTaskItemFileViewedPayloadSchema,
  MobileWebTaskItemInlineCommentPayloadSchema,
  MobileWebTaskItemInlineCommentResultSchema,
  MobileWebTaskItemRerunChecksPayloadSchema
} from '../../../src/shared/mobile-web/task-item-file-contract'
import type { HostTaskItemFileStatus } from '../tasks/host-task-item-file-operations'
import type { HostTaskGitHubItemTarget } from '../tasks/host-task-item-mutation-operations'
import { nativeHostTaskDetailOperations } from '../tasks/native-host-task-detail-operations'
import { nativeHostTaskItemFileOperations } from '../tasks/native-host-task-item-file-operations'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type {
  MobileWebGitHubTaskTarget,
  MobileWebTaskTargetAuthority
} from './mobile-web-task-target-authority'

const OPERATIONS = new Set([
  'refreshHostedTaskChecks',
  'rerunHostedTaskChecks',
  'setHostedTaskFileViewed',
  'loadHostedTaskFileContents',
  'addHostedTaskInlineComment'
])

export async function executeMobileWebTaskItemFileOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  targetAuthority: MobileWebTaskTargetAuthority
}): Promise<{ handled: boolean; result?: unknown }> {
  if (!OPERATIONS.has(args.operation)) {
    return { handled: false }
  }
  const pageTargetId = targetId(args.operation, args.payload)
  const target = requirePullRequest(args.targetAuthority.resolveGitHub(pageTargetId))
  const details = await nativeHostTaskDetailOperations(args.client).loadGitHub(target)
  args.targetAuthority.assertHostedTarget(pageTargetId, target)
  const operations = nativeHostTaskItemFileOperations(args.client)
  if (args.operation === 'refreshHostedTaskChecks') {
    return {
      handled: true,
      result: MobileWebTaskItemChecksResultSchema.parse({
        checks: await operations.refreshChecks(target, details.headSha)
      })
    }
  }
  if (args.operation === 'rerunHostedTaskChecks') {
    const payload = MobileWebTaskItemRerunChecksPayloadSchema.parse(args.payload)
    await operations.rerunChecks(target, requireIdentity(details.headSha), payload.failedOnly)
    return done()
  }
  if (args.operation === 'setHostedTaskFileViewed') {
    const payload = MobileWebTaskItemFileViewedPayloadSchema.parse(args.payload)
    requireFile(details, payload.path)
    await operations.setFileViewed(target, {
      pullRequestId: requireIdentity(details.pullRequestId),
      path: payload.path,
      viewed: payload.viewed
    })
    return done()
  }
  if (args.operation === 'loadHostedTaskFileContents') {
    const payload = MobileWebTaskItemFileContentsPayloadSchema.parse(args.payload)
    const file = requireFile(details, payload.path)
    return {
      handled: true,
      result: MobileWebTaskItemFileContentsResultSchema.parse(
        await operations.loadFileContents(target, {
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          status: file.status ?? 'modified',
          headSha: requireIdentity(details.headSha),
          baseSha: requireIdentity(details.baseSha)
        })
      )
    }
  }
  const payload = MobileWebTaskItemInlineCommentPayloadSchema.parse(args.payload)
  const file = requireFile(details, payload.path)
  return {
    handled: true,
    result: MobileWebTaskItemInlineCommentResultSchema.parse({
      comment: await operations.addInlineComment(target, {
        commitId: requireIdentity(details.headSha),
        path: file.path,
        line: payload.line,
        body: payload.body
      })
    })
  }
}

function requirePullRequest(
  target: MobileWebGitHubTaskTarget
): HostTaskGitHubItemTarget & { type: 'pr' } {
  if (target.type !== 'pr') {
    throw new MobileWebBrokerError('invalid_request')
  }
  return { provider: 'github', ...target, type: 'pr' }
}

function requireFile(
  details: MobileWebTaskGitHubDetailResult,
  path: string
): {
  path: string
  oldPath?: string
  status?: HostTaskItemFileStatus
} {
  const file = details.files.find((candidate) => candidate.path === path)
  if (!file) {
    throw new MobileWebBrokerError('conflict')
  }
  return file
}

function requireIdentity(value: string | undefined): string {
  if (!value) {
    throw new MobileWebBrokerError('conflict')
  }
  return value
}

function targetId(operation: string, payload: unknown): string {
  const schema =
    operation === 'refreshHostedTaskChecks'
      ? MobileWebTaskItemChecksPayloadSchema
      : operation === 'rerunHostedTaskChecks'
        ? MobileWebTaskItemRerunChecksPayloadSchema
        : operation === 'setHostedTaskFileViewed'
          ? MobileWebTaskItemFileViewedPayloadSchema
          : operation === 'loadHostedTaskFileContents'
            ? MobileWebTaskItemFileContentsPayloadSchema
            : MobileWebTaskItemInlineCommentPayloadSchema
  return schema.parse(payload).targetId
}

function done(): { handled: true; result: null } {
  return { handled: true, result: MobileWebTaskItemFileMutationResultSchema.parse(null) }
}
