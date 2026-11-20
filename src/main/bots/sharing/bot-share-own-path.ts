// The export's reads of a bot home: only the bot's own files, never through a link, and part names
// that can become folder and file names.
import { lstat, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { validateSkillPackageName } from '../../../shared/skills/packages/skill-package-manifest'

export type Home = { path: string; real: string }

export const validPartName = (name: string): boolean => {
  try {
    validateSkillPackageName(name)
    return true
  } catch {
    return false
  }
}

export function within(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep)
}

/** Every file the export reads goes through here: the bot's own file or folder at this path
 *  (resolved), `linked` when any part of the path is a link (its target could be anything on the
 *  computer, so it never goes out), or null when it is missing. */
export async function ownPath(
  home: Home,
  ...segments: string[]
): Promise<{ own: string } | 'linked' | null> {
  const path = join(home.path, ...segments)
  const real = await realpath(path).catch(() => null)
  if (real !== null && real === join(home.real, ...segments)) {
    return { own: real }
  }
  // A dangling link still counts as a link; a missing file under a linked folder has nothing to read.
  return real !== null || (await lstat(path).catch(() => null)) ? 'linked' : null
}
