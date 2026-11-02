import { randomUUID } from 'node:crypto'
import { readOrCreateBrowserHostClientId } from './browser-host-client-identity'

let browserHostClientId: string | null = null

/** Resolve identity before window creation stamps it into renderer argv. */
export function initializeBrowserClientHostId(profileDirectory: string): void {
  if (browserHostClientId) {
    // A renderer may already hold this ID; replacing it would orphan its hosted pages.
    console.warn('[browser-client-host] hosting identity was read before startup resolved it')
    return
  }
  browserHostClientId = readOrCreateBrowserHostClientId(profileDirectory)
}

/** Isolated so windows can read host identity without loading the client-host runtime graph. */
export function getBrowserClientHostId(): string {
  // A process-local fallback permits hosting, but cannot preserve tabs across relaunch.
  browserHostClientId ??= randomUUID()
  return browserHostClientId
}
