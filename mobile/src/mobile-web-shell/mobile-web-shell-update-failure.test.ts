import { describe, expect, it } from 'vitest'
import { MobileWebBundleFetchError } from '../transport/web-bundle/mobile-web-bundle-fetch-refusal'
import { markRpcDeliveryUnknown } from '../transport/rpc/rpc-delivery-ambiguity'
import { updateFailureCauseOf } from './mobile-web-shell-update-failure'

const TOKENED = 'wss://relay.example/pair?token=SECRET-123 bundle asset index.html hashed'

describe('updateFailureCauseOf', () => {
  it('never carries a URL, a query string or a token, whatever the error said', () => {
    const errors: unknown[] = [
      markRpcDeliveryUnknown(new Error(TOKENED)),
      new Error(`invalid_argument: mobile_web_bundle_unavailable ${TOKENED}`),
      new MobileWebBundleFetchError('asset-checksum-mismatch', TOKENED),
      new Error(TOKENED)
    ]
    for (const error of errors) {
      const text = JSON.stringify(updateFailureCauseOf(error))
      expect(text).not.toMatch(/SECRET|token|\?|:\/\//)
    }
  })
})
