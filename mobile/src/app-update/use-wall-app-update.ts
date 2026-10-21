import type { KnownAppUpdate } from '../storage/app-update-preferences'
import { useAppUpdateState } from './app-update-runtime'

// Dismissal is ignored: this release is the way past the wall. The checker's own cadence
// already covers the wall, so nothing is triggered here.
export function useWallAppUpdate(): KnownAppUpdate | null {
  return useAppUpdateState().available
}
