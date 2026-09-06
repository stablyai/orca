import {
  MobileWebTaskLinearCommentPayloadSchema,
  MobileWebTaskLinearCommentResultSchema,
  MobileWebTaskLinearConnectPayloadSchema,
  MobileWebTaskLinearCreatePayloadSchema,
  MobileWebTaskLinearCreatedIssueResultSchema,
  MobileWebTaskLinearEmptyPayloadSchema,
  MobileWebTaskLinearIssueResultSchema,
  MobileWebTaskLinearMutationResultSchema,
  MobileWebTaskLinearStateUpdatePayloadSchema,
  MobileWebTaskLinearStatesResultSchema,
  MobileWebTaskLinearSubIssuePayloadSchema,
  MobileWebTaskLinearTargetPayloadSchema,
  MobileWebTaskLinearTeamsResultSchema,
  MobileWebTaskLinearWorkspacePayloadSchema
} from '../../../src/shared/mobile-web/task-linear-contract'
import type { MobileWebTaskLinearIssue } from '../../../src/shared/mobile-web/task-list-contract'
import type { HostTaskLinearTarget } from '../tasks/host-task-linear-operations'
import { nativeHostTaskDetailOperations } from '../tasks/native-host-task-detail-operations'
import { nativeHostTaskLinearOperations } from '../tasks/native-host-task-linear-operations'
import { nativeHostTaskReadOperations } from '../tasks/native-host-task-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { pageLinearIssue } from './mobile-web-task-linear-projection'
import type {
  MobileWebLinearTaskTarget,
  MobileWebTaskTargetAuthority
} from './mobile-web-task-target-authority'

const OPERATIONS = new Set([
  'connectLinear',
  'listLinearTeams',
  'listLinearTeamStates',
  'selectLinearWorkspace',
  'updateLinearIssueState',
  'addLinearIssueComment',
  'loadLinearIssue',
  'createLinearSubIssue',
  'createLinearIssue'
])

export async function executeMobileWebTaskLinearOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  targetAuthority: MobileWebTaskTargetAuthority
}): Promise<{ handled: boolean; result?: unknown }> {
  if (!OPERATIONS.has(args.operation)) {
    return { handled: false }
  }
  const operations = nativeHostTaskLinearOperations(args.client)
  if (args.operation === 'connectLinear') {
    const payload = MobileWebTaskLinearConnectPayloadSchema.parse(args.payload)
    await operations.connect(payload.apiKey)
    return done()
  }
  if (args.operation === 'listLinearTeams') {
    MobileWebTaskLinearEmptyPayloadSchema.parse(args.payload)
    return {
      handled: true,
      result: MobileWebTaskLinearTeamsResultSchema.parse({ teams: await operations.listTeams() })
    }
  }
  if (args.operation === 'selectLinearWorkspace') {
    const payload = MobileWebTaskLinearWorkspacePayloadSchema.parse(args.payload)
    const context = await nativeHostTaskReadOperations(args.client).loadLinearContext()
    if (!context.status.workspaces.some((workspace) => workspace.id === payload.workspaceId)) {
      throw new MobileWebBrokerError('conflict')
    }
    await operations.selectWorkspace(payload.workspaceId)
    return done()
  }
  if (args.operation === 'createLinearIssue') {
    const payload = MobileWebTaskLinearCreatePayloadSchema.parse(args.payload)
    const teams = await operations.listTeams()
    const team = teams.find(
      (candidate) =>
        candidate.id === payload.teamId &&
        (payload.workspaceId === undefined || candidate.workspaceId === payload.workspaceId)
    )
    if (!team) {
      throw new MobileWebBrokerError('conflict')
    }
    const issue = await operations.createIssue({
      team,
      title: payload.title,
      ...(payload.description ? { description: payload.description } : {})
    })
    return {
      handled: true,
      result: MobileWebTaskLinearCreatedIssueResultSchema.parse({
        issue: pageCreatedIssue(issue, team.workspaceId, args.targetAuthority)
      })
    }
  }
  const payload = targetPayload(args.operation, args.payload)
  const target = args.targetAuthority.resolveLinear(payload.targetId)
  const issue = await freshIssue(args.client, target)
  const hostTarget = hostTargetFrom(issue, target, payload.targetId)
  if (args.operation === 'listLinearTeamStates') {
    return {
      handled: true,
      result: MobileWebTaskLinearStatesResultSchema.parse({
        states: await operations.teamStates(hostTarget)
      })
    }
  }
  if (args.operation === 'updateLinearIssueState') {
    const update = MobileWebTaskLinearStateUpdatePayloadSchema.parse(args.payload)
    const states = await operations.teamStates(hostTarget)
    if (!states.some((state) => state.id === update.stateId)) {
      throw new MobileWebBrokerError('conflict')
    }
    args.targetAuthority.assertLinearTarget(payload.targetId, target)
    await operations.updateState(hostTarget, update.stateId)
    return done()
  }
  if (args.operation === 'addLinearIssueComment') {
    const comment = MobileWebTaskLinearCommentPayloadSchema.parse(args.payload)
    args.targetAuthority.assertLinearTarget(payload.targetId, target)
    return {
      handled: true,
      result: MobileWebTaskLinearCommentResultSchema.parse({
        id: await operations.addComment(hostTarget, comment.body)
      })
    }
  }
  if (args.operation === 'loadLinearIssue') {
    return {
      handled: true,
      result: MobileWebTaskLinearIssueResultSchema.parse({
        issue: pageLinearIssue(issue, args.targetAuthority)
      })
    }
  }
  const subIssue = MobileWebTaskLinearSubIssuePayloadSchema.parse(args.payload)
  args.targetAuthority.assertLinearTarget(payload.targetId, target)
  const created = await operations.createSubIssue(hostTarget, subIssue.title)
  return {
    handled: true,
    result: MobileWebTaskLinearCreatedIssueResultSchema.parse({
      issue: pageCreatedIssue(created, issue.workspaceId, args.targetAuthority)
    })
  }
}

async function freshIssue(
  client: RpcClient,
  target: MobileWebLinearTaskTarget
): Promise<MobileWebTaskLinearIssue> {
  return (
    await nativeHostTaskDetailOperations(client).loadLinear({
      issueId: target.issueId,
      workspaceId: target.workspaceId
    })
  ).issue
}

function hostTargetFrom(
  issue: MobileWebTaskLinearIssue,
  target: MobileWebLinearTaskTarget,
  targetId: string
): HostTaskLinearTarget {
  return {
    issueId: target.issueId,
    workspaceId: target.workspaceId,
    teamId: issue.team.id,
    projectId: issue.project?.id,
    targetId
  }
}

function pageCreatedIssue(
  issue: { id: string; identifier: string; title?: string; url?: string },
  workspaceId: string | undefined,
  authority: MobileWebTaskTargetAuthority
) {
  return {
    ...issue,
    targetId: authority.registerLinear({
      issueId: issue.id,
      ...(workspaceId ? { workspaceId } : {})
    })
  }
}

function targetPayload(operation: string, payload: unknown) {
  const schema =
    operation === 'updateLinearIssueState'
      ? MobileWebTaskLinearStateUpdatePayloadSchema
      : operation === 'addLinearIssueComment'
        ? MobileWebTaskLinearCommentPayloadSchema
        : operation === 'createLinearSubIssue'
          ? MobileWebTaskLinearSubIssuePayloadSchema
          : MobileWebTaskLinearTargetPayloadSchema
  return schema.parse(payload)
}

function done(): { handled: true; result: null } {
  return { handled: true, result: MobileWebTaskLinearMutationResultSchema.parse(null) }
}
