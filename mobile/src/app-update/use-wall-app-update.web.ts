import type { KnownAppUpdate } from '../storage/app-update-preferences'

// The page bundle cannot see the native app's install source.
export const isGooglePlayInstall = false

// The page bundle must not carry the checker; the wall inside the page keeps the fallback link.
export function useWallAppUpdate(): KnownAppUpdate | null {
  return null
}
