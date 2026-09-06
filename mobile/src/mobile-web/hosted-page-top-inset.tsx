import { useMemo, type ReactNode } from 'react'
import {
  SafeAreaInsetsContext,
  useSafeAreaInsets,
  type EdgeInsets
} from 'react-native-safe-area-context'

/**
 * The Expo shell reserves the top safe area around the hosted WebView, so inside the document the
 * top edge is no longer a device edge. Android reports env(safe-area-inset-top) from the window's
 * display cutout without subtracting the WebView's offset, so every hosted screen would pad a
 * second time. The other edges still meet the device, so they keep their measured values.
 */
export function hostedPageTopInset(insets: EdgeInsets): EdgeInsets {
  return { ...insets, top: 0 }
}

export function HostedPageTopInsetProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets()
  const hostedInsets = useMemo(() => hostedPageTopInset(insets), [insets])
  return (
    <SafeAreaInsetsContext.Provider value={hostedInsets}>{children}</SafeAreaInsetsContext.Provider>
  )
}
