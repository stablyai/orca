import { requireOptionalNativeModule } from 'expo-modules-core'
import { Platform } from 'react-native'

export type WebViewProvider = { name: string; version: string; hasShellFeatures: boolean }

// Android only: the WebView provider and whether it has the shell's fences. Null when unknown.
export function currentWebViewProvider(): WebViewProvider | null {
  if (Platform.OS !== 'android') {
    return null
  }
  const shell = requireOptionalNativeModule<{
    currentWebViewProvider?: () => WebViewProvider | null
  }>('OrcaMobileWebShell')
  try {
    return shell?.currentWebViewProvider?.() ?? null
  } catch {
    return null
  }
}
