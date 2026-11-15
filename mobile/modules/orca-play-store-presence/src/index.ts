import { requireOptionalNativeModule } from 'expo-modules-core'

export type OrcaPlayStorePresenceModule = {
  /** Whether the Google Play Store app is installed and enabled. */
  isPlayStoreInstalled(): boolean
}

/** Null off Android and in a binary built before the module existed. */
export const OrcaPlayStorePresence =
  requireOptionalNativeModule<OrcaPlayStorePresenceModule>('OrcaPlayStorePresence')
