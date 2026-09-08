import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

export function rethrowMobileWebReviewError(error: unknown): never {
  if (error instanceof MobileWebBridgeClientError && error.code === 'conflict') {
    error.message = 'This review changed on the host. Refresh the review before saving again.'
  }
  throw error
}
