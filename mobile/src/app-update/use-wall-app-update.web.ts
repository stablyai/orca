import type { KnownAppUpdate } from '../storage/app-update-preferences'

// The page bundle cannot see the native build's install channel.
export const isGooglePlayBuild = false

// The page bundle must not carry the checker; the wall inside the page keeps the fallback link.
export function useWallAppUpdate(): KnownAppUpdate | null {
  return null
}
