import type { KnownAppUpdate } from '../storage/app-update-preferences'
import { useAppUpdateState } from './app-update-runtime'

// Ignore dismissal at update wall; checker’s existing cadence covers it without extra triggers.
export function useWallAppUpdate(): KnownAppUpdate | null {
  return useAppUpdateState().available
}
