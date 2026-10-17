import type { MobileColorScheme } from '../theme/mobile-theme'
export function applyNativeWindowAppearance(_scheme: MobileColorScheme): void {}

export function refreshNativeWindowAppearance(): void {}

export function getNativeSystemColorScheme(): MobileColorScheme | null {
  return null
}

export function subscribeNativeSystemAppearance(_listener: () => void): () => void {
  return () => {}
}
