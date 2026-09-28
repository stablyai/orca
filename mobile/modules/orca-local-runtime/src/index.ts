import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core'

export type LocalRuntimePhase =
  | 'not_installed'
  | 'installing'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'error'

export type LocalRuntimeStatus = {
  phase: LocalRuntimePhase
  /** proot | rootfs-download | rootfs-extract | packages | orcad | done */
  installStep: string | null
  endpoint: string | null
  /** orcad's mobile-scoped `orca://pair?code=` offer; feeds the normal pairing flow. */
  pairingUrl: string | null
  lastError: string | null
  restartCount: number
  /** The full desktop UI (web client) served by the on-device host, or null when not bundled. */
  webClientUrl: string | null
}

export type LocalRuntimeInstallOptions = {
  orcadBundleUrl: string
  orcadBundleSha256?: string
  rootfsUrl?: string
  rootfsSha256?: string
  aptPackages?: string[]
  reinstallRootfs?: boolean
}

type NativeModule = {
  isSupported(): boolean
  getStatus(): LocalRuntimeStatus
  getRecentLog(): string[]
  install(options: LocalRuntimeInstallOptions): Promise<void>
  start(port?: number | null): void
  stop(): void
  isIgnoringBatteryOptimizations(): boolean
  requestIgnoreBatteryOptimizations(): void
  addListener(event: 'onStatus', listener: (status: LocalRuntimeStatus) => void): EventSubscription
  addListener(event: 'onLog', listener: (payload: { line: string }) => void): EventSubscription
}

// Null on iOS and on Android builds without the standalone flavor's native module.
const native = requireOptionalNativeModule<NativeModule>('OrcaLocalRuntime')

export const OrcaLocalRuntime = native

export function isLocalRuntimeAvailable(): boolean {
  return native?.isSupported() ?? false
}
