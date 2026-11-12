import { isAbsolute, relative, resolve, sep } from 'node:path'

const TEMPORARY_ITEMS_SEGMENT = 'TemporaryItems'
const DRAG_PROVIDER_DIR_PREFIX = 'NSIRD_'

/** Lexical check only: whether a path could be a drag-temp file worth inspecting. */
export function mayNeedDragTempCopy(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && hasDragTempMarker(resolve(path).split(sep))
}

// True when the segments hold `TemporaryItems/NSIRD_*/<entry>`: something below the provider dir.
export function hasDragTempMarker(segments: readonly string[]): boolean {
  for (let i = 0; i + 2 < segments.length; i += 1) {
    if (
      segments[i] === TEMPORARY_ITEMS_SEGMENT &&
      segments[i + 1].startsWith(DRAG_PROVIDER_DIR_PREFIX)
    ) {
      return true
    }
  }
  return false
}

/** Path segments of `candidate` below `root`, or [] when it is not inside it. */
export function relativeSegments(root: string, candidate: string): string[] {
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return []
  }
  const segments = rel.split(sep)
  // Why: anchor at the temp root so a nested lookalike elsewhere is not copied.
  return segments[0] === TEMPORARY_ITEMS_SEGMENT ? segments : []
}

export function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
