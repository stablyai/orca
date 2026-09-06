import {
  MobileWebProviderReviewCreatePayloadSchema,
  MobileWebProviderReviewCreateResultSchema,
  MobileWebProviderReviewEligibilityPayloadSchema,
  MobileWebProviderReviewEligibilityResultSchema,
  MobileWebProviderReviewFieldsPayloadSchema,
  MobileWebProviderReviewFieldsResultSchema,
  type MobileWebProviderReviewCreatePayload,
  type MobileWebProviderReviewCreateResult,
  type MobileWebProviderReviewEligibilityPayload,
  type MobileWebProviderReviewEligibilityResult,
  type MobileWebProviderReviewFieldsPayload,
  type MobileWebProviderReviewFieldsResult
} from '../../shared/mobile-web/provider-review-creation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebProviderReviewCreationRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  eligibility(
    payload: MobileWebProviderReviewEligibilityPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewEligibilityResult> {
    return this.requests
      .request(
        'provider',
        'reviewCreationEligibility',
        payload,
        MobileWebProviderReviewEligibilityPayloadSchema,
        MobileWebProviderReviewEligibilityResultSchema,
        options
      )
      .then((result) => {
        if (
          result.workspaceId !== payload.workspaceId ||
          result.observedHead !== payload.expectedHead ||
          result.branch !== payload.expectedBranch
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  create(
    payload: MobileWebProviderReviewCreatePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewCreateResult> {
    return this.requests
      .request(
        'provider',
        'reviewCreate',
        payload,
        MobileWebProviderReviewCreatePayloadSchema,
        MobileWebProviderReviewCreateResultSchema,
        options
      )
      .then((result) => {
        if (result.workspaceId !== payload.workspaceId || result.provider !== payload.provider) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  generateFields(
    payload: MobileWebProviderReviewFieldsPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewFieldsResult> {
    return this.requests
      .request(
        'provider',
        'reviewGenerateFields',
        payload,
        MobileWebProviderReviewFieldsPayloadSchema,
        MobileWebProviderReviewFieldsResultSchema,
        options
      )
      .then((result) => {
        if (result.workspaceId !== payload.workspaceId) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }
}
