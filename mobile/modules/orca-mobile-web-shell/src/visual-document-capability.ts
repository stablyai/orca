import { requireOptionalNativeModule } from 'expo-modules-core'
import { Platform } from 'react-native'

export function supportsVisualDocuments(): boolean {
  if (Platform.OS === 'web') {
    return false
  }
  const shell = requireOptionalNativeModule<{ supportsVisualDocuments?: () => boolean }>(
    'OrcaMobileWebShell'
  )
  return shell?.supportsVisualDocuments?.() === true
}
