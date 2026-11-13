export interface BundleProtocolFacts {
  schemaVersion: number
  runtimeProtocolVersion: number
  minCompatibleRuntimeProtocolVersion: number
  pageVersion: number
}

export interface DesktopProtocolFacts {
  protocolVersion?: number
  minCompatibleMobileVersion?: number
}

interface BundleVerdict {
  kind: string
  reason?: string
  side?: string
}

declare const bundleCompat: {
  MOBILE_WEB_PAGE_VERSION_FLOOR: number
  MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS: number
  SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS: number[]
  evaluateCompat(input: {
    desktopProtocolVersion: number | undefined
    desktopMinCompatibleMobileVersion: number | undefined
  }): BundleVerdict
  evaluateMobileWebBundleCompat(input: {
    hostCapabilities: string[]
    hostStatus: DesktopProtocolFacts
    manifest: BundleProtocolFacts | null
  }): BundleVerdict
}

export default bundleCompat
