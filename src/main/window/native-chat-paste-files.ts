// Orca's folder for local native-chat pastes no send claims: a terminal-backed chat's, and every
// paste from before structured chats used their attachment store. Never swept, since nothing tells
// which of them a sent message names; a restore keeps only files that really are inside it.

import { lstat, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { NATIVE_CHAT_PASTE_FOLDER } from '../../shared/native-chat-paste-folder'

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
