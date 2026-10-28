import { app } from 'electron'
import { join } from 'node:path'

let orcaProfileDirectory: string | null = null

/** Browser profile ids repeat across Orca profiles ("default"), so their extension data lives per Orca profile. */
export function configureBrowserExtensionProfileDataDirectory(profileDirectory: string): void {
  orcaProfileDirectory = profileDirectory
}

/** Root of the per-browser-profile extension stores (sync storage, grants and state, DNR). */
export function getBrowserExtensionProfileDataDirectory(): string {
  return join(orcaProfileDirectory ?? app.getPath('userData'), 'browser-extensions')
}
