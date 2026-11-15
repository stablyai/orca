import { requireOptionalNativeModule } from 'expo-modules-core'

export type WatchActionSpikeNativeEvent = {
  kind: 'launch' | 'response' | 'hold-started' | 'hold-ended'
  at: number
  appState?: string
  protectedData?: boolean
  notificationId?: string
  action?: string
  deliveredAt?: number
  replyChars?: number
  remainingSec?: number
  reason?: string
  heldMs?: number
}

export type OrcaWatchActionSpikeModule = {
  readEvents(): Promise<WatchActionSpikeNativeEvent[]>
  clearEvents(): Promise<void>
  endHold(): Promise<void>
  isProtectedDataAvailable(): Promise<boolean>
  setPairingKeychainReadableWhileLocked(
    enabled: boolean
  ): Promise<{ updated: number; status: number }>
}

/** Null on Android and in binaries built before the module existed. */
export const OrcaWatchActionSpike =
  requireOptionalNativeModule<OrcaWatchActionSpikeModule>('OrcaWatchActionSpike')
