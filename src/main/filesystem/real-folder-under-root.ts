import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'

/** `segments` under `root`: a real folder there (no link on the way), missing with nothing on the
 *  way a link, or anything else. `realRoot` is `root` with its own links resolved. */
export async function realFolderUnderRoot(
  root: string,
  realRoot: string,
  segments: readonly string[]
): Promise<'real' | 'missing' | 'other'> {
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const path = join(root, ...segments.slice(0, depth))
    const entry = await lstat(path).catch(() => null)
    if (!entry) {
      return 'missing'
    }
    const expected = join(realRoot, ...segments.slice(0, depth))
    if (!entry.isDirectory() || (await realpath(path)) !== expected) {
      return 'other'
    }
  }
  return 'real'
}
