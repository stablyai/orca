import { existsSync, opendirSync, statSync } from 'node:fs'
import type { posix, win32 } from 'node:path'

export type SshConfigPathApi = typeof posix | typeof win32

export type BoundedSshConfigGlobResult = {
  matches: string[]
  totalMatches: number
  truncated: boolean
  patternTooDeep: boolean
}

const MAX_GLOB_PATTERN_SEGMENTS = 64

export function resolveBoundedSshConfigGlob(
  absolutePattern: string,
  pathApi: SshConfigPathApi,
  matchLimit: number
): BoundedSshConfigGlobResult {
  const root = pathApi.parse(absolutePattern).root
  const segments = absolutePattern.slice(root.length).split(pathApi.sep).filter(Boolean)
  if (segments.length > MAX_GLOB_PATTERN_SEGMENTS) {
    return { matches: [], totalMatches: 0, truncated: true, patternTooDeep: true }
  }

  const matches: string[] = []
  let totalMatches = 0
  const retainMatch = (matchedPath: string): void => {
    totalMatches += 1
    insertSortedWithinLimit(matches, matchedPath, matchLimit)
  }

  const visit = (directoryPath: string, segmentIndex: number): void => {
    const segment = segments[segmentIndex]
    const isLast = segmentIndex === segments.length - 1
    if (!hasGlobPattern(segment)) {
      const nextPath = pathApi.join(directoryPath, segment)
      if (isLast) {
        if (existsSync(nextPath)) {
          retainMatch(nextPath)
        }
        return
      }
      visit(nextPath, segmentIndex + 1)
      return
    }

    let directory: ReturnType<typeof opendirSync>
    try {
      directory = opendirSync(directoryPath)
    } catch {
      return
    }
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (!pathApi.matchesGlob(entry.name, segment)) {
          continue
        }
        const nextPath = pathApi.join(directoryPath, entry.name)
        if (isLast) {
          retainMatch(nextPath)
          continue
        }
        if (entry.isDirectory() || isDirectorySymlink(nextPath, entry.isSymbolicLink())) {
          visit(nextPath, segmentIndex + 1)
        }
      }
    } finally {
      directory.closeSync()
    }
  }

  if (segments.length === 0) {
    if (existsSync(root)) {
      retainMatch(root)
    }
  } else {
    visit(root, 0)
  }
  return {
    matches,
    totalMatches,
    truncated: totalMatches > matchLimit,
    patternTooDeep: false
  }
}

function insertSortedWithinLimit(target: string[], value: string, limit: number): void {
  if (limit <= 0) {
    return
  }
  let low = 0
  let high = target.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (target[middle].localeCompare(value) <= 0) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  if (low >= limit) {
    return
  }
  target.splice(low, 0, value)
  if (target.length > limit) {
    target.pop()
  }
}

function isDirectorySymlink(filePath: string, isSymbolicLink: boolean): boolean {
  if (!isSymbolicLink) {
    return false
  }
  try {
    return statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function hasGlobPattern(input: string): boolean {
  return /[*?[]/.test(input)
}
