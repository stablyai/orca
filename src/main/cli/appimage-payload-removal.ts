import { rm } from 'node:fs/promises'

// Why a counter and not a saved value: `process.noAsar` is process-wide, so two overlapping
// removals would race — the first to settle would restore the shim while the second is still
// running, and the rest of that removal would silently leak again. Removals are sequential today;
// this keeps that a property of the module rather than of its callers.
let activeRemovals = 0
// Captured once when the outermost removal starts; `process.noAsar` is typed boolean, and an
// unset flag is falsy, so restoring `false` is equivalent to restoring `undefined`.
let asarBeforeOutermostRemoval = false

/**
 * Removes an extracted AppImage payload tree.
 *
 * Why not a plain recursive `rm`: Electron patches `fs` so a `*.asar` file reports
 * `isDirectory() === true`. A recursive remove then tries to `rmdir` a real file, fails with
 * ENOTEMPTY, and strands the ~105 MB `resources/app.asar` of every superseded generation.
 * `process.noAsar` restores real filesystem semantics; the window is ~33 ms for a full 519 MB
 * generation, and nothing in the registration path reads asar content inside it.
 */
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
