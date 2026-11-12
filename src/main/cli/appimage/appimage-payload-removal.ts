import { rm } from 'node:fs/promises'

// Keep the process-wide asar shim disabled until every overlapping removal settles.
let activeRemovals = 0
// An unset noAsar flag is equivalent to false.
let asarBeforeOutermostRemoval = false

// Electron reports asar files as directories, breaking recursive rm; noAsar restores real fs semantics.
export async function removeExtractedAppImagePayload(targetPath: string): Promise<void> {
  if (activeRemovals === 0) {
    asarBeforeOutermostRemoval = process.noAsar === true
  }
  activeRemovals += 1
  process.noAsar = true
  try {
    await rm(targetPath, { recursive: true, force: true })
  } finally {
    activeRemovals -= 1
    if (activeRemovals === 0) {
      process.noAsar = asarBeforeOutermostRemoval
    }
  }
}
