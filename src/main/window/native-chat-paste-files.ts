// Local native-chat pastes live in an Orca-owned folder, so a restored draft can show and send them:
// a restore keeps only files that really are inside it, and old files expire.

import { lstat, readdir, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { NATIVE_CHAT_PASTE_FOLDER } from '../../shared/native-chat-paste-folder'

// Why 30 days: no age bounds what can still name a paste (a queued send is retried with a new id
// after the host's 24 h id window), so this is a judgment. A draft or outbox entry kept longer meets
// its image as a placeholder or a failed send, and a sent paste's file lingers until then.
export const NATIVE_CHAT_PASTE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const PASTE_FILE_NAME = /^orca-paste-.+\.png$/i
const MAX_RESTORED_PASTES = 256

type PathApi = typeof path.posix

export type RestoredNativeChatPaste = { path: string; kept: boolean; exists: boolean }

export function nativeChatPasteFolder(): string {
  return path.join(getAppEnvironment().getPath('userData'), NATIVE_CHAT_PASTE_FOLDER)
}

/** A path as compared for containment: no `\\?\` prefix, and case-folded where the platform is. */
function comparablePath(value: string, pathApi: PathApi, platform: string): string {
  const unprefixed = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
  const normalized = pathApi.normalize(unprefixed)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** True when `target` names something strictly inside `folder`; both must already be real paths. */
export function isInsideNativeChatPasteFolder(
  folder: string,
  target: string,
  pathApi: PathApi = path,
  platform: string = process.platform
): boolean {
  const relative = pathApi.relative(
    comparablePath(folder, pathApi, platform),
    comparablePath(target, pathApi, platform)
  )
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  )
}

/**
 * For each restored local paste: kept only when its real path is a file inside the real paste
 * folder (symlinks and junctions resolved). Anything else comes back as a placeholder. Nothing is
 * granted: the preview reads a paste with chat-image access. Never throws.
 */
export async function restoreNativeChatPastes(paths: unknown): Promise<RestoredNativeChatPaste[]> {
  if (!Array.isArray(paths)) {
    return []
  }
  const folders = await realPasteFolder()
  return Promise.all(
    paths
      .slice(0, MAX_RESTORED_PASTES)
      .flatMap((value) =>
        typeof value === 'string' ? [restoreNativeChatPaste(folders, value)] : []
      )
  )
}

/** The paste folder as configured and as real path; null when missing or itself a link. */
async function realPasteFolder(): Promise<{ named: string; real: string } | null> {
  try {
    const named = path.resolve(nativeChatPasteFolder())
    const info = await lstat(named)
    return info.isDirectory() && !info.isSymbolicLink()
      ? { named, real: await realpath(named) }
      : null
  } catch {
    return null
  }
}

async function restoreNativeChatPaste(
  folders: { named: string; real: string } | null,
  restored: string
): Promise<RestoredNativeChatPaste> {
  const refused = { path: restored, kept: false, exists: false }
  if (folders === null || restored === '' || !path.isAbsolute(restored)) {
    return refused
  }
  // Why both: the text the draft stores and the file it really names must each be inside.
  const named = path.resolve(restored)
  if (
    !isInsideNativeChatPasteFolder(folders.named, named) &&
    !isInsideNativeChatPasteFolder(folders.real, named)
  ) {
    return refused
  }
  try {
    const real = await realpath(restored)
    if (!isInsideNativeChatPasteFolder(folders.real, real) || !(await stat(real)).isFile()) {
      return refused
    }
    return { path: restored, kept: true, exists: true }
  } catch {
    // Missing or unreadable: not kept, and nothing about an outside path is reported.
    return refused
  }
}

/** Deletes pastes older than the TTL: only Orca's paste files, never a link, a folder, or anything
 *  in a paste folder that is itself a link. Failures are logged and never block startup. */
export async function sweepExpiredNativeChatPastes(now = Date.now()): Promise<void> {
  const folders = await realPasteFolder()
  if (!folders) {
    return
  }
  const folder = folders.named
  let entries
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !PASTE_FILE_NAME.test(entry.name)) {
      continue
    }
    const file = path.join(folder, entry.name)
    try {
      const info = await lstat(file)
      if (info.isFile() && now - info.mtimeMs > NATIVE_CHAT_PASTE_TTL_MS) {
        await unlink(file)
      }
    } catch (error) {
      console.warn('[native-chat-pastes] could not expire a paste:', error)
    }
  }
}
