import {
  MobileWebTaskProjectChecksPayloadSchema,
  MobileWebTaskProjectChecksResultSchema,
  MobileWebTaskProjectCommentAddResultSchema,
  MobileWebTaskProjectFileContentsPayloadSchema,
  MobileWebTaskProjectFileContentsResultSchema,
  MobileWebTaskProjectFileViewedPayloadSchema,
  MobileWebTaskProjectInlineCommentPayloadSchema,
  MobileWebTaskProjectMutationResultSchema
} from '../../../src/shared/mobile-web/task-project-mutation-contract'
import { nativeHostTaskProjectFileOperations } from '../tasks/native-host-task-project-file-operations'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  revalidateProjectRepo,
  revalidateProjectTarget
} from './mobile-web-task-project-mutation-operations'
import type { MobileWebTaskTargetAuthority } from './mobile-web-task-target-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const OPERATIONS = new Set([
  'refreshProjectChecks',
  'setProjectFileViewed',
  'loadProjectFileContents',
  'addProjectInlineComment'
])

export async function executeMobileWebTaskProjectFileOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  targetAuthority: MobileWebTaskTargetAuthority
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<{ handled: boolean; result?: unknown }> {
  if (!OPERATIONS.has(args.operation)) {
    return { handled: false }
  }
  const identifiers = identifiersFor(args.operation, args.payload)
  const target = args.targetAuthority.resolveGitHubProject(identifiers.targetId)
  const fresh = await revalidateProjectTarget(args.client, target)
  if (fresh.item.type !== 'pr') {
    throw new MobileWebBrokerError('invalid_request')
  }
  const repoId = await revalidateProjectRepo(
    args.client,
    args.workspaceAuthority,
    identifiers.repoId,
    fresh.item
  )
  args.targetAuthority.assertGitHubProjectTarget(identifiers.targetId, target)
  const operations = nativeHostTaskProjectFileOperations(args.client)
  if (args.operation === 'refreshProjectChecks') {
    const payload = MobileWebTaskProjectChecksPayloadSchema.parse(args.payload)
    return {
      handled: true,
      result: MobileWebTaskProjectChecksResultSchema.parse({
        checks: await operations.refreshChecks(fresh.item, repoId, payload.headSha)
      })
    }
  }
  if (args.operation === 'setProjectFileViewed') {
    const payload = MobileWebTaskProjectFileViewedPayloadSchema.parse(args.payload)
    await operations.setFileViewed(fresh.item, repoId, {
      pullRequestId: payload.pullRequestId,
      path: payload.path,
      viewed: payload.viewed
    })
    return done()
  }
  if (args.operation === 'loadProjectFileContents') {
    const payload = MobileWebTaskProjectFileContentsPayloadSchema.parse(args.payload)
    return {
      handled: true,
      result: MobileWebTaskProjectFileContentsResultSchema.parse(
        await operations.loadFileContents(fresh.item, repoId, {
          path: payload.path,
          ...(payload.oldPath ? { oldPath: payload.oldPath } : {}),
          status: payload.status,
          headSha: payload.headSha,
          baseSha: payload.baseSha
        })
      )
    }
  }
  const payload = MobileWebTaskProjectInlineCommentPayloadSchema.parse(args.payload)
  return {
    handled: true,
    result: MobileWebTaskProjectCommentAddResultSchema.parse({
      comment: await operations.addInlineComment(fresh.item, repoId, {
        commitId: payload.commitId,
        path: payload.path,
        line: payload.line,
        body: payload.body
      })
    })
  }
}

function identifiersFor(operation: string, payload: unknown) {
  const schema =
    operation === 'refreshProjectChecks'
      ? MobileWebTaskProjectChecksPayloadSchema
      : operation === 'setProjectFileViewed'
        ? MobileWebTaskProjectFileViewedPayloadSchema
        : operation === 'loadProjectFileContents'
          ? MobileWebTaskProjectFileContentsPayloadSchema
          : MobileWebTaskProjectInlineCommentPayloadSchema
  const parsed = schema.parse(payload)
  return { targetId: parsed.targetId, repoId: parsed.repoId }
}

function done(): { handled: true; result: null } {
  return { handled: true, result: MobileWebTaskProjectMutationResultSchema.parse(null) }
}
