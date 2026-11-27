import { rm, writeFile } from 'node:fs/promises'
import {
  getRuntimeRestartMarkerPath,
  type RuntimeRestartMarker,
  type RuntimeRestartReason
} from '../../../../shared/remote-runtime/bootstrap/runtime-restart-marker'

/** Tells CLI callers in surviving terminals that the app is coming back, not gone. */
export async function writeRuntimeRestartMarker(
  userDataPath: string,
  reason: RuntimeRestartReason
): Promise<void> {
  const marker: RuntimeRestartMarker = { reason, writtenAt: Date.now(), pid: process.pid }
  try {
    await writeFile(getRuntimeRestartMarkerPath(userDataPath), JSON.stringify(marker), {
      mode: 0o600
    })
  } catch (error) {
    console.warn('[runtime] Could not write the restart marker:', error)
  }
}

export async function clearRuntimeRestartMarker(userDataPath: string): Promise<void> {
  try {
    await rm(getRuntimeRestartMarkerPath(userDataPath), { force: true })
  } catch (error) {
    console.warn('[runtime] Could not clear the restart marker:', error)
  }
}
