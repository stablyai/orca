import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebProviderReviewCreationRequestClient } from './mobile-web-provider-review-creation-request-client'
import { MobileWebProviderReviewRequestClient } from './mobile-web-provider-review-request-client'
import { MobileWebSourceControlReviewRequestClient } from './mobile-web-source-control-review-request-client'

export function mobileWebReviewClientBindings(requests: MobileWebOneShotRequestClient) {
  const sourceControl = new MobileWebSourceControlReviewRequestClient(requests)
  const provider = new MobileWebProviderReviewRequestClient(requests)
  const creation = new MobileWebProviderReviewCreationRequestClient(requests)
  return {
    sourceControlReviewMetadata: sourceControl.metadata.bind(sourceControl),
    sourceControlReviewMetadataUpdate: sourceControl.metadataUpdate.bind(sourceControl),
    sourceControlReviewLink: sourceControl.link.bind(sourceControl),
    sourceControlReviewLinkUpdate: sourceControl.linkUpdate.bind(sourceControl),
    sourceControlReviewDiff: sourceControl.diff.bind(sourceControl),
    sourceControlReviewOpen: sourceControl.open.bind(sourceControl),
    sourceControlReviewTerminalSend: sourceControl.terminalSend.bind(sourceControl),
    providerReview: provider.review.bind(provider),
    providerReviewCreationEligibility: creation.eligibility.bind(creation),
    providerReviewCreate: creation.create.bind(creation),
    providerReviewGenerateFields: creation.generateFields.bind(creation),
    providerReviewDiff: provider.reviewDiff.bind(provider),
    providerReviewQuery: provider.reviewQuery.bind(provider),
    providerMutateReview: provider.mutateReview.bind(provider),
    providerManageReview: provider.manageReview.bind(provider),
    providerSubmitReview: provider.submitReview.bind(provider)
  }
}
