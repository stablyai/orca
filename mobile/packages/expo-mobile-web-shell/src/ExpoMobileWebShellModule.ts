import { requireOptionalNativeModule } from 'expo-modules-core'

export type CommittedMobileWebGeneration = {
  buildId: string
}

export type MobileWebShellSession = {
  sessionId: string
  buildId: string
  url: string
}

type ExpoMobileWebShellNativeModule = {
  /** Writes one complete asset; JS reassembles and verifies it before handing it over. */
  writeStagedAsset(
    hostIdentity: string,
    buildId: string,
    path: string,
    dataBase64: string
  ): Promise<void>
  commitGeneration(
    hostIdentity: string,
    buildId: string,
    manifestJson: string
  ): Promise<CommittedMobileWebGeneration>
  abortGeneration(hostIdentity: string, buildId: string): Promise<void>
  openSession(
    hostIdentity: string,
    buildId: string | null,
    bridgeVersion: number
  ): Promise<MobileWebShellSession>
  closeSession(sessionId: string): Promise<void>
  removeHost(hostIdentity: string): Promise<void>
  activateViewSession(sessionId: string): Promise<void>
  deactivateViewSession(sessionId: string): Promise<void>
  postViewMessage(sessionId: string, message: string): Promise<void>
}

const nativeModule =
  requireOptionalNativeModule<ExpoMobileWebShellNativeModule>('ExpoMobileWebShell')

// Why: this module is imported (transitively) from the app's initial route, so a missing pod —
// Expo Go, a stale dev client — used to throw at module scope and white-screen the launch.
// Failing at the call instead lets callers that already tolerate failure degrade.
const missingNativeModule = new Proxy({} as ExpoMobileWebShellNativeModule, {
  get(_target, property) {
    return () => Promise.reject(new Error(`ExpoMobileWebShell is unavailable: ${String(property)}`))
  }
})

export default nativeModule ?? missingNativeModule
