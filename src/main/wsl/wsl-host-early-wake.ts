/**
 * Older builds booted the last focused WSL host's distro at launch from this list. That broke E9
 * (a launch restore is passive), so nothing writes or reads the list now; a launch deletes a list
 * an older build left behind.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const WAKE_FILE = 'orca-wsl-host-wake.json'

export function deleteLegacyWslHostWakeList(userDataPath: string): void {
  try {
    rmSync(join(userDataPath, WAKE_FILE), { force: true })
  } catch (error) {
    // Nothing reads it any more; a leftover file is inert.
    console.warn('[wsl-hosts] Could not delete the old early-wake list:', error)
  }
}
