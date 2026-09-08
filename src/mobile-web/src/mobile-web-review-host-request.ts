import type { z } from 'zod'
import { rethrowMobileWebReviewError } from './mobile-web-provider-review-conflict'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

/** Every provider-review call names a workspace the desktop never learns: the shell rewrites the
 *  handle into its own worktree, so the page strips it on the way out and restores it on the way
 *  back before the result contract is applied. */
export function requestMobileWebReviewHost<TPayload extends { workspaceId: string }, TResult>(
  requests: MobileWebOneShotRequestClient,
  method: string,
  payload: TPayload,
  payloadSchema: z.ZodType<TPayload>,
  resultSchema: z.ZodType<TResult>,
  options?: MobileWebBridgeRequestOptions
): Promise<TResult> {
  const parsedPayload = payloadSchema.safeParse(payload)
  if (!parsedPayload.success) {
    return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
  }
  const { workspaceId, ...params } = parsedPayload.data
  return requestMobileWebHost(requests, method, workspaceId, params, options)
    .then((result) => {
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      const parsed = resultSchema.safeParse({ ...result, workspaceId })
      if (!parsed.success) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return parsed.data
    })
    .catch(rethrowMobileWebReviewError)
}

export function assertMobileWebReviewEcho(matches: boolean): void {
  if (!matches) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
}
