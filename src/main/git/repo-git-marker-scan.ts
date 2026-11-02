import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { normalizeRuntimePathSeparators } from '../../shared/cross-platform-path'
import { resolveGitMetadataPath } from '../../shared/git-metadata-path'
import { parseGitdirMarkerPayload } from '../../shared/gitdir-marker-payload'

export type GitMarkerScanResult =
  | { status: 'valid'; rootPath: string }
  | { status: 'absent' | 'invalid' }

/** Filesystem fallback for genuine Git metadata when git cannot answer cleanly. */
export function scanGitMarkerSync(path: string): GitMarkerScanResult {
  const realPath = resolveRealPathSync(path)
  if (realPath && realPath !== path) {
    const lexicalScan = scanGitMarkerAncestorsSync(path)
    const realPathScan = scanGitMarkerAncestorsSync(realPath)
    if (
      lexicalScan.status === 'valid' &&
      realPathScan.status === 'valid' &&
      pathsReferToSameEntry(lexicalScan.rootPath, realPathScan.rootPath)
    ) {
      // Why: preserve lexical spellings, but let a cross-repo symlink bind to its real target.
      return lexicalScan
    }
    return realPathScan
  }
  return scanGitMarkerAncestorsSync(path)
}

export function resolveRealPathSync(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  }
}

function scanGitMarkerAncestorsSync(path: string): GitMarkerScanResult {
  for (const candidate of ancestorDirectories(path)) {
    if (!isInsideDotGitMarker(candidate, path)) {
      const worktreeMarker = scanWorktreeMarkerSync(candidate)
      if (worktreeMarker.status !== 'absent') {
        return worktreeMarker
      }
    }
    if (hasValidBareRepoMarkerSync(candidate)) {
      return { status: 'valid', rootPath: candidate }
    }
  }
  return { status: 'absent' }
}

function ancestorDirectories(path: string): string[] {
  const directories: string[] = []
  let current = path
  while (true) {
    directories.push(current)
    const parent = dirname(current)
    if (parent === current) {
      return directories
    }
    current = parent
  }
}

function isInsideDotGitMarker(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return false
  }
  const firstSegment = relativePath.split(/[\\/]+/)[0]
  if (firstSegment === '.git') {
    return true
  }
  if (firstSegment.toLowerCase() !== '.git') {
    return false
  }
  return pathsReferToSameEntry(join(rootPath, firstSegment), join(rootPath, '.git'))
}

function pathsReferToSameEntry(leftPath: string, rightPath: string): boolean {
  try {
    const leftStat = statSync(leftPath)
    const rightStat = statSync(rightPath)
    if (leftStat.ino !== 0 && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) {
      return true
    }
    const leftRealPath = normalizeRuntimePathSeparators(realpathSync.native(leftPath))
    const rightRealPath = normalizeRuntimePathSeparators(realpathSync.native(rightPath))
    return process.platform === 'win32'
      ? leftRealPath.toLowerCase() === rightRealPath.toLowerCase()
      : leftRealPath === rightRealPath
  } catch {
    return false
  }
}

function scanWorktreeMarkerSync(worktreePath: string): GitMarkerScanResult {
  const dotGit = join(worktreePath, '.git')
  let marker: ReturnType<typeof statSync>
  try {
    marker = statSync(dotGit)
  } catch {
    return { status: 'absent' }
  }

  if (marker.isDirectory()) {
    return hasValidGitDirectorySync(dotGit)
      ? { status: 'valid', rootPath: worktreePath }
      : { status: 'invalid' }
  }
  if (marker.isFile()) {
    let gitDir: string | null
    try {
      gitDir = parseGitdirFile(worktreePath, readFileSync(dotGit, 'utf8'))
    } catch {
      return { status: 'invalid' }
    }
    return gitDir !== null && hasValidGitDirectorySync(gitDir)
      ? { status: 'valid', rootPath: worktreePath }
      : { status: 'invalid' }
  }
  return { status: 'invalid' }
}

function parseGitdirFile(basePath: string, content: string): string | null {
  const payload = parseGitdirMarkerPayload(content)
  return payload === null ? null : resolveGitMetadataPath(basePath, payload)
}

function hasValidGitDirectorySync(gitDir: string): boolean {
  return hasValidCommonGitDirectorySync(gitDir) || hasValidLinkedWorktreeGitDirectorySync(gitDir)
}

function hasValidCommonGitDirectorySync(gitDir: string): boolean {
  try {
    return (
      statSync(join(gitDir, 'HEAD')).isFile() &&
      statSync(join(gitDir, 'objects')).isDirectory() &&
      statSync(join(gitDir, 'refs')).isDirectory()
    )
  } catch {
    return false
  }
}

function hasValidLinkedWorktreeGitDirectorySync(gitDir: string): boolean {
  try {
    if (!statSync(join(gitDir, 'HEAD')).isFile() || !statSync(join(gitDir, 'commondir')).isFile()) {
      return false
    }
    const commonDir = resolveGitMetadataPath(
      gitDir,
      readFileSync(join(gitDir, 'commondir'), 'utf8')
    )
    return commonDir !== null && hasValidCommonGitDirectorySync(commonDir)
  } catch {
    return false
  }
}

function hasValidBareRepoMarkerSync(path: string): boolean {
  return hasValidCommonGitDirectorySync(path) && !gitConfigDeclaresNonBare(path)
}

function gitConfigDeclaresNonBare(gitDir: string): boolean {
  try {
    const config = readFileSync(join(gitDir, 'config'), 'utf8')
    let inCoreSection = false
    for (const line of config.split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)\]/)
      if (section) {
        inCoreSection = section[1].trim().toLowerCase() === 'core'
        continue
      }
      const bare = line.match(/^\s*bare\s*=\s*(.*?)\s*$/i)
      if (inCoreSection && bare) {
        return isGitBooleanFalse(normalizeGitConfigValue(bare[1]))
      }
    }
    return false
  } catch {
    return false
  }
}

function normalizeGitConfigValue(value: string): string {
  const unescaped = stripGitConfigInlineComment(value).trim().replace(/\\"/g, '"')
  if (
    unescaped.length >= 2 &&
    ((unescaped.startsWith('"') && unescaped.endsWith('"')) ||
      (unescaped.startsWith("'") && unescaped.endsWith("'")))
  ) {
    return unescaped.slice(1, -1)
  }
  return unescaped
}

function stripGitConfigInlineComment(value: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' || char === ';') {
      return value.slice(0, i)
    }
  }
  return value
}

function isGitBooleanFalse(value: string): boolean {
  return ['', 'false', 'no', 'off', '0'].includes(value.toLowerCase())
}
