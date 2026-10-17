import { requireOptionalNativeModule } from 'expo-modules-core'
import { colors, getMobileColorScheme, type MobileColorScheme } from '../theme/mobile-theme'
const appearance = requireOptionalNativeModule<{
  addListener?: (event: string, listener: () => void) => { remove: () => void }
  getSystemColorScheme?: () => MobileColorScheme
  setColorScheme: (scheme: MobileColorScheme, surface: string) => Promise<void>
}>('OrcaMobileAppearance')
export function applyNativeWindowAppearance(scheme: MobileColorScheme): void {
  void appearance?.setColorScheme(scheme, colors.bgBase).catch(() => {})
}

export function refreshNativeWindowAppearance(): void {
  applyNativeWindowAppearance(getMobileColorScheme())
}

export function getNativeSystemColorScheme(): MobileColorScheme | null {
  return appearance?.getSystemColorScheme?.() ?? null
}

export function subscribeNativeSystemAppearance(listener: () => void): () => void {
  const subscription = appearance?.addListener?.('systemColorSchemeChanged', listener)
  return () => subscription?.remove()
}
