import { lstat, readlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { isSafeDescendCandidate } from '../pty/overlay-mirror'
import type { OpenCodeOverlayManifest } from './opencode-overlay-manifest'
import { sourceOverlayDirName } from './overlay-dir-names'

export type SourceDirectoryPresence = 'present' | 'absent' | 'unverifiable'

function isAbsent(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

export async function inspectSourceDirectory(path: string): Promise<SourceDirectoryPresence> {
  if (!isAbsolute(path)) {
    return 'unverifiable'
  }
  const absolute = resolve(path)
  let current = parse(absolute).root
  const segments = relative(current, absolute).split(sep).filter(Boolean)
  for (const segment of ['', ...segments]) {
    current = join(current, segment)
    try {
      if (!isSafeDescendCandidate(await lstat(current))) {
        return 'unverifiable'
      }
    } catch (error) {
      return isAbsent(error) ? 'absent' : 'unverifiable'
    }
  }
  return 'present'
}

export async function resolveOwnedOverlaySource(
  directory: string,
  manifest: OpenCodeOverlayManifest
): Promise<string | undefined> {
  const matches = (source: string): boolean =>
    isAbsolute(source) && sourceOverlayDirName(source) === basename(directory)
  if (manifest.sourceConfigDir !== undefined) {
    return matches(manifest.sourceConfigDir) ? manifest.sourceConfigDir : undefined
  }
  // Older manifests prove a source only through a named, source-hash-matching mirror.
  let source: string | undefined
  for (const entry of manifest.topLevelEntries) {
    if (!entry || basename(entry) !== entry || entry === '.' || entry === '..') {
      return undefined
    }
    try {
      const target = await readlink(join(directory, entry))
      const candidate = dirname(target)
      if (!isAbsolute(target) || basename(target) !== entry || !matches(candidate)) {
        return undefined
      }
      if (source !== undefined && source !== candidate) {
        return undefined
      }
      source = candidate
    } catch {
      return undefined
    }
  }
  return source
}
