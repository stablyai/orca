import { rename, rm, writeFile } from 'node:fs/promises'
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
  const markerPath = getRuntimeRestartMarkerPath(userDataPath)
  const tempPath = `${markerPath}.${process.pid}.tmp`
  try {
    // Rename so a CLI reading mid-write never sees a torn marker and skips the wait.
    await writeFile(tempPath, JSON.stringify(marker), { mode: 0o600 })
    await rename(tempPath, markerPath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
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
