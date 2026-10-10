/**
 * The spawn the window's own `pty:spawn` performs, for a host launch that must start its agent
 * exactly as that window would (a desktop automation's run). Installed with the IPC handler, so a
 * host without that handler has none.
 */

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PtyIpcSpawnAnswer, PtySpawnIpcArgs } from './spawn-types'

export type WindowPtySpawn = {
  spawn: (args: PtySpawnIpcArgs) => Promise<PtyIpcSpawnAnswer | { isReattach: true }>
  /** The settings that window builds its launch from. */
  getSettings: () => GlobalSettings
}

let installed: WindowPtySpawn | null = null

export function installWindowPtySpawn(spawn: WindowPtySpawn | null): void {
  installed = spawn
}

export function getWindowPtySpawn(): WindowPtySpawn | null {
  return installed
}
