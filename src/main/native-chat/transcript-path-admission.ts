import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { isDescendantOrEqual, isENOENT } from '../ipc/filesystem-path-containment'
import { isWslUncPath } from '../../shared/wsl-paths'
import { needsWslHostResolution } from './host-readable-transcript-path'

/** Account containment must survive symlinks and host-native path translation. */
export async function admitTranscriptPath(root: string, candidate: string) {
  if (
    !isAbsolute(root) ||
    !isAbsolute(candidate) ||
    isWslUncPath(root) ||
    isWslUncPath(candidate) ||
    needsWslHostResolution(candidate)
  ) {
    return null
  }
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    canonicalPath(resolve(root)),
    canonicalPath(resolve(candidate))
  ])
  return canonicalRoot &&
    canonicalCandidate &&
    isDescendantOrEqual(canonicalCandidate, canonicalRoot)
    ? { path: canonicalCandidate, relativePath: relative(canonicalRoot, canonicalCandidate) }
    : null
}

/** Resolve missing files through the deepest existing ancestor so linked account roots still compare equal. */
async function canonicalPath(path: string): Promise<string | null> {
  const missing: string[] = []
  let existing = path
  for (;;) {
    try {
      return resolve(await realpath(existing), ...missing)
    } catch (error) {
      if (!isENOENT(error)) {
        throw error
      }
      const parent = dirname(existing)
      // A dangling link gives no evidence of where a later read would land.
      if (parent === existing || (await isDanglingLink(existing))) {
        return null
      }
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

async function isDanglingLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch (error) {
    if (isENOENT(error)) {
      return false
    }
    throw error
  }
}
