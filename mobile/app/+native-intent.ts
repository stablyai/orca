import { isIncomingShareUrl } from '../src/share/incoming-share'

// useIncomingShareIntake reads the share and opens Home; the marker link itself names no route.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  return isIncomingShareUrl(path) ? null : path
}
