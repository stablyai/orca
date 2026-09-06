import {
  MobileWebCreationBlankPayloadSchema,
  MobileWebCreationFromSourcePayloadSchema,
  MobileWebCreationResultSchema,
  type MobileWebCreationBlankPayload,
  type MobileWebCreationFromSourcePayload,
  type MobileWebCreationResult
} from '../../shared/mobile-web/workspace-creation-create-contract'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebWorkspaceCreationCreateRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  createBlank(payload: MobileWebCreationBlankPayload): Promise<MobileWebCreationResult> {
    return this.requests.request(
      'workspace',
      'creationCreateBlank',
      payload,
      MobileWebCreationBlankPayloadSchema,
      MobileWebCreationResultSchema
    )
  }

  createFromSource(payload: MobileWebCreationFromSourcePayload): Promise<MobileWebCreationResult> {
    return this.requests.request(
      'workspace',
      'creationCreateFromSource',
      payload,
      MobileWebCreationFromSourcePayloadSchema,
      MobileWebCreationResultSchema
    )
  }
}
