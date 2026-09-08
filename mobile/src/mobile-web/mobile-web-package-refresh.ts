import ExpoMobileWebShell, { type MobileWebShellSession } from '@orca/expo-mobile-web-shell'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import { MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES } from '../../../src/shared/mobile-web/package-rpc-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { HostProfile } from '../transport/types'
import { mobileWebDiagnosticsStore } from './mobile-web-diagnostics-store'
import { createMobileWebNativeStager } from './mobile-web-native-stager'
import {
  downloadMobileWebPackage,
  mobileWebPackageDownloadFailureCode,
  type MobileWebPackageDownloadProgress
} from './mobile-web-package-downloader'
import { mobileWebPackageRefreshWarning } from './mobile-web-package-refresh-warning'
import type { MobileWebPackageCapability } from './mobile-web-package-session-state'
import type { MobileWebShellNotice } from './mobile-web-shell-notice'

/** `stale` means the attempt outlived the host selection it started under and published nothing. */
export type MobileWebPackageRefreshOutcome =
  | { kind: 'settled' }
  | { kind: 'stale' }
  | { kind: 'failed'; warning: MobileWebShellNotice }

/**
 * One refresh attempt, start to finish: download, open, publish, and classify. The hook keeps the
 * lifecycle; this keeps the sequence.
 */
export async function runMobileWebPackageRefresh(args: {
  client: RpcClient
  host: HostProfile
  capability: MobileWebPackageCapability
  signal: AbortSignal
  isCurrent: () => boolean
  isVerifiedBuild: (buildId: string) => Promise<boolean>
  onProgress: (progress: MobileWebPackageDownloadProgress) => void
  publish: (session: MobileWebShellSession, startedAt: number) => Promise<boolean>
  onDownloaded: () => void
  hasSession: () => boolean
}): Promise<MobileWebPackageRefreshOutcome> {
  const startedAt = Date.now()
  try {
    const downloaded = await downloadMobileWebPackage(
      (method, params) => args.client.sendRequest(method, params),
      createMobileWebNativeStager(args.host.publicKeyB64),
      {
        shellBridgeVersion: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        useGzip: args.capability.gzip,
        ...(args.capability.range ? { rangeBytes: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES } : {}),
        signal: args.signal,
        onProgress: args.onProgress,
        reuseVerifiedBuild: args.isVerifiedBuild
      }
    )
    args.onDownloaded()
    if (!args.isCurrent()) {
      return { kind: 'stale' }
    }
    if (!downloaded.reusedVerifiedBuild) {
      const session = await ExpoMobileWebShell.openSession(
        args.host.publicKeyB64,
        downloaded.commit.buildId,
        MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
      )
      if (!args.isCurrent()) {
        await ExpoMobileWebShell.closeSession(session.sessionId).catch(() => {})
        return { kind: 'stale' }
      }
      if (!(await args.publish(session, startedAt))) {
        return { kind: 'stale' }
      }
    }
    mobileWebDiagnosticsStore.refreshSucceeded(args.host.id, Date.now() - startedAt)
    return { kind: 'settled' }
  } catch (error) {
    if (!args.isCurrent()) {
      return { kind: 'stale' }
    }
    const failureCode = mobileWebPackageDownloadFailureCode(error)
    mobileWebDiagnosticsStore.warning(args.host.id, failureCode)
    console.warn('[mobile-web] package refresh failed', { code: failureCode })
    return {
      kind: 'failed',
      warning: mobileWebPackageRefreshWarning(failureCode, args.hasSession(), args.host.name)
    }
  }
}
