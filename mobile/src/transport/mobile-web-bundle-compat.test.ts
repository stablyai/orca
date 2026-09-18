import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import {
  evaluateMobileWebBundleCompat,
  SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS,
  type MobileWebBundleCompatManifest,
  type MobileWebBundleCompatVerdict,
  type MobileWebBundleHostStatus
} from './mobile-web-bundle-compat'

const CAPABLE: readonly string[] = ['browser.screencast.v1', MOBILE_WEB_BUNDLE_CAPABILITY]

function manifest(
  overrides: Partial<MobileWebBundleCompatManifest> = {}
): MobileWebBundleCompatManifest {
  return {
    schemaVersion: 1,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeProtocolVersion: 2,
    ...overrides
  }
}

function evaluate(input: {
  hostCapabilities?: readonly string[]
  hostStatus?: MobileWebBundleHostStatus
  manifest?: MobileWebBundleCompatManifest | null
}): MobileWebBundleCompatVerdict {
  return evaluateMobileWebBundleCompat({
    hostCapabilities: input.hostCapabilities ?? CAPABLE,
    hostStatus: input.hostStatus ?? { protocolVersion: 3, minCompatibleMobileVersion: 2 },
    manifest: input.manifest === undefined ? manifest() : input.manifest
  })
}

describe('evaluateMobileWebBundleCompat', () => {
  it('opens a bundle whose window contains the host', () => {
    expect(evaluate({})).toEqual({ kind: 'ok' })
  })

  it('answers the capability question before a manifest exists', () => {
    expect(evaluate({ manifest: null })).toEqual({ kind: 'ok' })
    expect(evaluate({ hostCapabilities: [], manifest: null })).toEqual({
      kind: 'blocked',
      reason: 'bundle-unavailable'
    })
  })

  it('blocks a host that ships no bundle', () => {
    expect(evaluate({ hostCapabilities: ['browser.screencast.v1'] })).toEqual({
      kind: 'blocked',
      reason: 'bundle-unavailable'
    })
  })

  it('blocks a manifest schema this shell does not know', () => {
    expect(evaluate({ manifest: manifest({ schemaVersion: 2 }) })).toEqual({
      kind: 'blocked',
      reason: 'bundle-shell-too-old',
      schemaVersion: 2,
      supportedSchemaVersions: SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS
    })
    // A schema below the known one is just as unreadable as one above it.
    expect(evaluate({ manifest: manifest({ schemaVersion: 0 }) })).toMatchObject({
      reason: 'bundle-shell-too-old',
      schemaVersion: 0
    })
  })

  it('blocks a host older than the bundle it serves', () => {
    expect(
      evaluate({
        hostStatus: { protocolVersion: 1, minCompatibleMobileVersion: 0 },
        manifest: manifest({ minCompatibleRuntimeProtocolVersion: 2 })
      })
    ).toEqual({
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'desktop',
      hostProtocolVersion: 1,
      requiredHostProtocolVersion: 2
    })
  })

  it('blocks a bundle older than the host expects', () => {
    expect(
      evaluate({
        hostStatus: { protocolVersion: 9, minCompatibleMobileVersion: 4 },
        manifest: manifest({ runtimeProtocolVersion: 3, minCompatibleRuntimeProtocolVersion: 0 })
      })
    ).toEqual({
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'mobile',
      bundleRuntimeProtocolVersion: 3,
      requiredBundleRuntimeProtocolVersion: 4
    })
  })

  it('reports the missing capability first when the host also fails every later check', () => {
    expect(
      evaluate({
        hostCapabilities: [],
        hostStatus: { protocolVersion: 0, minCompatibleMobileVersion: 99 },
        manifest: manifest({ schemaVersion: 7, minCompatibleRuntimeProtocolVersion: 5 })
      })
    ).toEqual({ kind: 'blocked', reason: 'bundle-unavailable' })
  })

  it('reports an unknown schema before reading the protocol window inside it', () => {
    expect(
      evaluate({
        hostStatus: { protocolVersion: 0, minCompatibleMobileVersion: 99 },
        manifest: manifest({ schemaVersion: 2, minCompatibleRuntimeProtocolVersion: 5 })
      })
    ).toMatchObject({ reason: 'bundle-shell-too-old' })
  })

  it('reports the desktop side before the mobile side when both windows miss', () => {
    expect(
      evaluate({
        hostStatus: { protocolVersion: 1, minCompatibleMobileVersion: 99 },
        manifest: manifest({ runtimeProtocolVersion: 3, minCompatibleRuntimeProtocolVersion: 5 })
      })
    ).toMatchObject({ reason: 'bundle-incompatible', side: 'desktop' })
  })

  it('treats an omitted host protocolVersion as the oldest host that could have answered', () => {
    expect(
      evaluate({
        hostStatus: {},
        manifest: manifest({ minCompatibleRuntimeProtocolVersion: 1 })
      })
    ).toEqual({
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'desktop',
      hostProtocolVersion: 0,
      requiredHostProtocolVersion: 1
    })
  })

  it('treats an omitted host minCompatibleMobileVersion as no floor at all', () => {
    expect(
      evaluate({
        hostStatus: {},
        manifest: manifest({ runtimeProtocolVersion: 0, minCompatibleRuntimeProtocolVersion: 0 })
      })
    ).toEqual({ kind: 'ok' })
  })

  it('opens at the boundary of both windows, so equality is not a block', () => {
    expect(
      evaluate({
        hostStatus: { protocolVersion: 2, minCompatibleMobileVersion: 3 },
        manifest: manifest({ runtimeProtocolVersion: 3, minCompatibleRuntimeProtocolVersion: 2 })
      })
    ).toEqual({ kind: 'ok' })
    // One below either boundary is the block the equality case sits next to.
    expect(
      evaluate({
        hostStatus: { protocolVersion: 1, minCompatibleMobileVersion: 3 },
        manifest: manifest({ runtimeProtocolVersion: 3, minCompatibleRuntimeProtocolVersion: 2 })
      })
    ).toMatchObject({ reason: 'bundle-incompatible', side: 'desktop' })
    expect(
      evaluate({
        hostStatus: { protocolVersion: 2, minCompatibleMobileVersion: 4 },
        manifest: manifest({ runtimeProtocolVersion: 3, minCompatibleRuntimeProtocolVersion: 2 })
      })
    ).toMatchObject({ reason: 'bundle-incompatible', side: 'mobile' })
  })

  it('knows exactly one schema, so the wall exists the moment the contract bumps', () => {
    expect(SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS).toEqual([1])
  })
})
