import type { MobileWebBridgeOperationName } from '../../shared/mobile-web/bridge-operation-registry'
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
  MobileWebTaskLinearWorkspacePayloadSchema,
  type MobileWebTaskLinearCommentPayload,
  type MobileWebTaskLinearConnectPayload,
  type MobileWebTaskLinearCreatePayload,
  type MobileWebTaskLinearStateUpdatePayload,
  type MobileWebTaskLinearSubIssuePayload,
  type MobileWebTaskLinearWorkspacePayload
} from '../../shared/mobile-web/task-linear-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebTaskItemRequestClient } from './mobile-web-task-item-request-client'

export class MobileWebTaskLinearRequestClient extends MobileWebTaskItemRequestClient {
  constructor(requests: MobileWebOneShotRequestClient) {
    super(requests)
  }

  connectLinear(payload: MobileWebTaskLinearConnectPayload) {
    return this.requests.request(
      'task',
      'connectLinear',
      payload,
      MobileWebTaskLinearConnectPayloadSchema,
      MobileWebTaskLinearMutationResultSchema
    )
  }

  listLinearTeams(payload: Record<string, never>) {
    return this.requests.request(
      'task',
      'listLinearTeams',
      payload,
      MobileWebTaskLinearEmptyPayloadSchema,
      MobileWebTaskLinearTeamsResultSchema
    )
  }

  listLinearTeamStates(payload: { targetId: string }) {
    return this.requests.request(
      'task',
      'listLinearTeamStates',
      payload,
      MobileWebTaskLinearTargetPayloadSchema,
      MobileWebTaskLinearStatesResultSchema
    )
  }

  selectLinearWorkspace(payload: MobileWebTaskLinearWorkspacePayload) {
    return this.mutateLinear(
      'selectLinearWorkspace',
      payload,
      MobileWebTaskLinearWorkspacePayloadSchema
    )
  }

  updateLinearIssueState(payload: MobileWebTaskLinearStateUpdatePayload) {
    return this.mutateLinear(
      'updateLinearIssueState',
      payload,
      MobileWebTaskLinearStateUpdatePayloadSchema
    )
  }

  addLinearIssueComment(payload: MobileWebTaskLinearCommentPayload) {
    return this.requests.request(
      'task',
      'addLinearIssueComment',
      payload,
      MobileWebTaskLinearCommentPayloadSchema,
      MobileWebTaskLinearCommentResultSchema
    )
  }

  loadLinearIssue(payload: { targetId: string }) {
    return this.requests
      .request(
        'task',
        'loadLinearIssue',
        payload,
        MobileWebTaskLinearTargetPayloadSchema,
        MobileWebTaskLinearIssueResultSchema
      )
      .then((result) => {
        if (result.issue.targetId !== payload.targetId) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  createLinearSubIssue(payload: MobileWebTaskLinearSubIssuePayload) {
    return this.requests.request(
      'task',
      'createLinearSubIssue',
      payload,
      MobileWebTaskLinearSubIssuePayloadSchema,
      MobileWebTaskLinearCreatedIssueResultSchema
    )
  }

  createLinearIssue(payload: MobileWebTaskLinearCreatePayload) {
    return this.requests.request(
      'task',
      'createLinearIssue',
      payload,
      MobileWebTaskLinearCreatePayloadSchema,
      MobileWebTaskLinearCreatedIssueResultSchema
    )
  }

  private mutateLinear(
    operation: MobileWebBridgeOperationName<'task'>,
    payload: unknown,
    schema: ZodType
  ) {
    return mutate(schema, this.requests, operation, payload)
  }
}

function mutate(
  schema: ZodType,
  requests: MobileWebOneShotRequestClient,
  operation: MobileWebBridgeOperationName<'task'>,
  payload: unknown
) {
  return requests.request(
    'task',
    operation,
    payload,
    schema,
    MobileWebTaskLinearMutationResultSchema
  )
}
import type { ZodType } from 'zod'
