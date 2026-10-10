/**
 * The spawn and stop the window's own `pty:spawn` and `pty:kill` perform, for a host launch that must
 * start its agent exactly as that window would (a desktop automation's run). Installed with those
 * handlers on every host that has settings, headless ones included; only a desktop caller reaches it.
 */

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PtyIpcSpawnAnswer, PtySpawnIpcArgs } from './spawn-types'

export type WindowPtySpawn = {
  spawn: (args: PtySpawnIpcArgs) => Promise<PtyIpcSpawnAnswer | { isReattach: true }>
  /** Stops a PTY the way the window stops its own (`pty:kill`). */
  stop: (ptyId: string) => Promise<void>
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
