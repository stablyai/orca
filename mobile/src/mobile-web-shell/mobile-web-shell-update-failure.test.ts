import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_FETCH_REFUSALS,
  MobileWebBundleFetchError
} from '../transport/mobile-web-bundle-fetch-refusal'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { RpcIncompatibleReplyError } from '../transport/rpc-incompatible-reply-error'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  readFailureSide,
  updateFailureCauseOf,
  updateFailureWallOf
} from './mobile-web-shell-update-failure'

/** A message the way a transport or a fetch can phrase one: an endpoint and a credential in it. */
const TOKENED = 'wss://relay.example/pair?token=SECRET-123 bundle asset index.html hashed'

describe('updateFailureCauseOf', () => {
  it('reads a request the link cut off as the link going', () => {
    expect(updateFailureCauseOf(markRpcDeliveryUnknown(new Error(TOKENED)))).toEqual({
      reason: 'connection-lost',
      hostCode: null
    })
    expect(updateFailureCauseOf(new LogicalClientCutoverError())).toEqual({
      reason: 'connection-lost',
      hostCode: null
    })
  })

  it("keeps the host's own bundle code", () => {
    expect(
      updateFailureCauseOf(new Error('invalid_argument: mobile_web_bundle_read_limited'))
    ).toEqual({ reason: 'host-refused', hostCode: 'mobile_web_bundle_read_limited' })
  })

  it.each(MOBILE_WEB_BUNDLE_FETCH_REFUSALS)(
    'keeps the fetch refusal %s as its reason',
    (refusal) => {
      expect(updateFailureCauseOf(new MobileWebBundleFetchError(refusal, TOKENED))).toEqual({
        reason: refusal,
        hostCode: null
      })
    }
  )

  it('reads a reply this client could not decode as unreadable', () => {
    expect(
      updateFailureCauseOf(new RpcIncompatibleReplyError('op', 'mobileWeb.bundle.manifest', []))
    ).toEqual({ reason: 'reply-unreadable', hostCode: null })
  })

  it('answers anything else with a code, never the message', () => {
    const cause = updateFailureCauseOf(new Error(TOKENED))
    expect(cause).toEqual({ reason: 'unrecognised-error', hostCode: null })
    expect(updateFailureCauseOf('not even an error')).toEqual(cause)
  })

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

describe('readFailureSide', () => {
  it('puts only the two link reasons on the transport side', () => {
    expect(readFailureSide('no-connection')).toBe('transport')
    expect(readFailureSide('connection-lost')).toBe('transport')
    expect(readFailureSide('asset-checksum-mismatch')).toBe('bundle')
    expect(readFailureSide('cache-write-failed')).toBe('bundle')
    expect(readFailureSide('unrecognised-error')).toBe('bundle')
  })
})

describe('updateFailureWallOf', () => {
  it('flattens each blocked verdict to one code', () => {
    expect(updateFailureWallOf({ kind: 'blocked', reason: 'bundle-unavailable' })).toBe(
      'bundle-unavailable'
    )
    expect(
      updateFailureWallOf({ kind: 'blocked', reason: 'bundle-shell-too-old', schemaVersion: 9 })
    ).toBe('bundle-shell-too-old')
    expect(
      updateFailureWallOf({
        kind: 'blocked',
        reason: 'bundle-incompatible',
        side: 'desktop',
        hostProtocolVersion: 1,
        requiredHostProtocolVersion: 2
      })
    ).toBe('host-too-old-for-bundle')
    expect(
      updateFailureWallOf({
        kind: 'blocked',
        reason: 'bundle-incompatible',
        side: 'mobile',
        bundleRuntimeProtocolVersion: 0,
        requiredBundleRuntimeProtocolVersion: 1
      })
    ).toBe('bundle-too-old-for-host')
  })
})
