import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
  MOBILE_WEB_PAGE_VERSION
} from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../src/shared/protocol-version'
import {
  evaluateMobileWebBundleCompat,
  MOBILE_WEB_PAGE_VERSION_FLOOR
} from './mobile-web-bundle-compat'

describe("the shell's page floor", () => {
  it('accepts the page built beside this shell and refuses a page below its floor', () => {
    const input = {
      hostCapabilities: [MOBILE_WEB_BUNDLE_CAPABILITY],
      hostStatus: {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
      },
      manifest: {
        schemaVersion: MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
        pageVersion: MOBILE_WEB_PAGE_VERSION
      }
    }
    expect(evaluateMobileWebBundleCompat(input)).toEqual({ kind: 'ok', manifestChecked: true })
    expect(
      evaluateMobileWebBundleCompat({
        ...input,
        manifest: { ...input.manifest, pageVersion: MOBILE_WEB_PAGE_VERSION_FLOOR - 1 }
      })
    ).toEqual({
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'desktop',
      pageVersion: MOBILE_WEB_PAGE_VERSION_FLOOR - 1,
      requiredPageVersion: MOBILE_WEB_PAGE_VERSION_FLOOR
    })
  })
})
