import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

/** Replace the ownership marker atomically so a process crash cannot leave
 * truncated JSON that permanently blocks safe Mission recovery. */
export function writeMissionRootMarkerFile(markerPath: string, contents: string): void {
  const temporaryPath = `${markerPath}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporaryPath, markerPath)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The rename succeeded or the temporary file was never created.
    }
    throw error
  }
}
