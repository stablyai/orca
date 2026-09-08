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
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import {
  assertMobileWebReviewEcho,
  requestMobileWebReviewHost
} from './mobile-web-review-host-request'

export class MobileWebProviderReviewCreationRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  eligibility(
    payload: MobileWebProviderReviewEligibilityPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewEligibilityResult> {
    return requestMobileWebReviewHost(
      this.requests,
      'mobileWeb.review.creationEligibility',
      payload,
      MobileWebProviderReviewEligibilityPayloadSchema,
      MobileWebProviderReviewEligibilityResultSchema,
      options
    ).then((result) => {
      assertMobileWebReviewEcho(
        result.observedHead === payload.expectedHead && result.branch === payload.expectedBranch
      )
      return result
    })
  }

  create(
    payload: MobileWebProviderReviewCreatePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewCreateResult> {
    return requestMobileWebReviewHost(
      this.requests,
      'mobileWeb.review.create',
      payload,
      MobileWebProviderReviewCreatePayloadSchema,
      MobileWebProviderReviewCreateResultSchema,
      options
    ).then((result) => {
      assertMobileWebReviewEcho(result.provider === payload.provider)
      return result
    })
  }

  generateFields(
    payload: MobileWebProviderReviewFieldsPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewFieldsResult> {
    return requestMobileWebReviewHost(
      this.requests,
      'mobileWeb.review.generateFields',
      payload,
      MobileWebProviderReviewFieldsPayloadSchema,
      MobileWebProviderReviewFieldsResultSchema,
      options
    )
  }
}
