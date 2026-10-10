import { requireOptionalNativeModule } from 'expo-modules-core'

export type NativeAppIcon = {
  supportsAlternateIcons(): Promise<boolean>
  getAlternateIconName(): Promise<string | null>
  setAlternateIconName(name: string | null): Promise<void>
}

// Optional: a dev client built before this module existed hides the setting instead of crashing.
export const nativeAppIcon = requireOptionalNativeModule<NativeAppIcon>('OrcaAppIcon')
