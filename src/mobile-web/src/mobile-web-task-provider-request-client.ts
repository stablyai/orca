import {
  MobileWebTaskIssueSourcePayloadSchema,
  MobileWebTaskProviderIssueCreatePayloadSchema,
  MobileWebTaskProviderIssueCreateResultSchema,
  MobileWebTaskProviderMutationResultSchema,
  type MobileWebTaskIssueSourcePayload,
  type MobileWebTaskProviderIssueCreatePayload
} from '../../shared/mobile-web/task-provider-write-contract'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebTaskLinearRequestClient } from './mobile-web-task-linear-request-client'

export class MobileWebTaskProviderRequestClient extends MobileWebTaskLinearRequestClient {
  constructor(requests: MobileWebOneShotRequestClient) {
    super(requests)
  }

  createProviderIssue(payload: MobileWebTaskProviderIssueCreatePayload) {
    return this.requests.request(
      'task',
      'createProviderIssue',
      payload,
      MobileWebTaskProviderIssueCreatePayloadSchema,
      MobileWebTaskProviderIssueCreateResultSchema
    )
  }

  updateIssueSource(payload: MobileWebTaskIssueSourcePayload) {
    return this.requests.request(
      'task',
      'updateIssueSource',
      payload,
      MobileWebTaskIssueSourcePayloadSchema,
      MobileWebTaskProviderMutationResultSchema
    )
  }
}
