// Where synced files live on this computer and which cloud paths may be written there. The cloud
// side is not trusted: a path that could land outside the folder, or in a git or sync-internal
// directory, is dropped before anything touches the disk.
import { lstat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

/** `~/orca/cloud/<repository>/<workspace>`, beside the `~/orca/workspaces/…` convention. */
export const CLOUD_SYNC_BASE_SEGMENTS = ['orca', 'cloud'] as const
export const CONTEXT_DIR = '.context'
/** Temp files for in-flight copies; inside the folder so the final rename stays on one volume. */
export const SYNC_TEMP_DIR = '.orca-sync-tmp'

const MAX_SEGMENT_LENGTH = 80
const MAX_PATH_LENGTH = 1024
// Bidi overrides and zero-width characters could disguise a name in Finder.
// oxlint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const UNSAFE_CHARS = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/

/** One folder name from a repository or workspace name: printable, no separators, not hidden. */
export function folderSegment(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? '')
    .normalize('NFC')
    .replace(UNSAFE_CHARS, '')
    .replace(/[/\\:]/g, '-')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, MAX_SEGMENT_LENGTH)
    .trim()
  return cleaned.length > 0 ? cleaned : fallback
}

export function cloudSyncFolder(
  args: { repoName?: string; workspaceName?: string; workspaceId: string },
  home: string = homedir()
): string {
  return join(
    home,
    ...CLOUD_SYNC_BASE_SEGMENTS,
    folderSegment(args.repoName, 'workspace'),
    folderSegment(args.workspaceName, args.workspaceId.slice(0, 12))
  )
}

/** `~/orca/cloud/…` for display. */
export function displayPath(path: string, home: string = homedir()): string {
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

/**
 * A cloud-relative path that is safe to mirror: forward slashes, no empty/`.`/`..` segments, no
 * absolute or drive paths, no control characters, never inside `.git` or this sync's temp dir.
 */
export function isSafeSyncPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    return false
  }
  if (path.startsWith('/') || path.includes('\\') || UNSAFE_CHARS.test(path)) {
    return false
  }
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return false
    }
    if (segment.length > 255) {
      return false
    }
  }
  const first = segments[0]!
  if (first === '.git' || first === SYNC_TEMP_DIR || segments.includes('.git')) {
    return false
  }
  return true
}

export function isContextPath(path: string): boolean {
  return path === CONTEXT_DIR || path.startsWith(`${CONTEXT_DIR}/`)
}

/** Every parent of `relativePath` under `root` exists as a real directory (no links). */
export async function hasSafeParents(root: string, relativePath: string): Promise<boolean> {
  let current = root
  for (const segment of relativePath.split('/').slice(0, -1)) {
    current = join(current, segment)
    const info = await lstat(current).catch(() => null)
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      return false
    }
  }
  return true
}

/**
 * Creates the parent directories of `relativePath` under `root`, refusing any component that is
 * a symlink or not a directory, so a planted link can't redirect a write outside the folder.
 */
export async function ensureSafeParent(root: string, relativePath: string): Promise<string> {
  const segments = relativePath.split('/')
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    let info = await lstat(current).catch(() => null)
    if (!info) {
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') {
          throw error
        }
      })
      info = await lstat(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('unsafe_parent')
    }
  }
  return join(root, ...segments)
}
