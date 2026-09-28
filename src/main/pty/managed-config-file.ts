// Why: Orca installs its own status plugin at a fixed filename inside agent
// config directories the user owns, and that leaf may already be a symlink the
// user (or a previous overlay) left there. Writing to it would send Orca's bytes
// through the link into the user's real files, so the entry is always removed
// first and a fresh file written in its place.
//
// Only a proven absence may skip that removal. A swallowed unlink error is the
// specific defect this replaces: it let the write proceed through whatever was
// still at the path. Kept in one module because MiMo and OpenCode must not
// diverge on where that line sits -- they are meant to differ in exactly one
// respect, the exclusive flag below, and nothing else.
//
// Scope note: this guards the leaf only, and makes no claim about the containing
// directory. Callers that need the parent proven real call
// ensureOverlayDirectory themselves; the writer that installs into the user's
// own canonical config dir intentionally does not, because that directory is
// legitimately theirs.

import { unlinkSync, writeFileSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

/**
 * Replace the file at `path` with `contents`, removing whatever entry is there
 * rather than writing through it.
 *
 * `exclusive` adds O_EXCL so a link re-created between the unlink and the write
 * fails the write instead of redirecting it. It is a caller option because it is
 * not free: an overlay shared by concurrent panes would turn that race into an
 * EEXIST that costs a pane its status plugin, which is worse than the race it
 * closes on a directory already proven real.
 */
export function writeManagedConfigFile(
  path: string,
  contents: string,
  options?: { exclusive?: boolean }
): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  if (options?.exclusive === true) {
    writeFileSync(path, contents, { flag: 'wx' })
    return
  }
  writeFileSync(path, contents)
}
