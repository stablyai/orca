import { lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { RuntimeStore } from '../runtime-store-contract'
import {
  isDeviceNamespacePath,
  isNetworkSharePath,
  isWindowsReservedDeviceName
} from '../../ipc/automatic-load-path-text'
import {
  resolveAuthorizedPath,
  type ResolveAuthorizedPathOptions
} from '../../ipc/filesystem/filesystem-auth'
import { isENOENT } from '../../ipc/filesystem/filesystem-path-containment'
import { nativeChatScratchRootFor } from '../../native-chat/native-chat-scratch-folder'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'

const PATH_SELECTOR_PREFIX = 'path:'
const SCRATCH_FOLDER_NAME = /^[0-9a-f]{32}$/

function chatScratchRoot(): string {
  return nativeChatScratchRootFor(getProfileUserDataPath())
}

export function resolveRuntimeAuthorizedPath(
  targetPath: string,
  store: RuntimeStore,
  options: ResolveAuthorizedPathOptions = {}
): Promise<string> {
  return resolveAuthorizedPath(targetPath, store, {
    ...options,
    extraRoots: [...(options.extraRoots ?? []), chatScratchRoot()]
  })
}

/**
 * A local file already persisted in `openFilesByWorktree` has desktop `user-file` authority for
 * that exact path, provided it is an absolute local path and not a device or network share.
 */
export function extraRootsForPersistedOpenFile(filePath: string): readonly string[] {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    return []
  }
  const resolved = resolve(filePath)
  if (
    isDeviceNamespacePath(resolved) ||
    isWindowsReservedDeviceName(resolved) ||
    isNetworkSharePath(resolved)
  ) {
    return []
  }
  return [resolved]
}

export function isChatScratchWorktreeId(worktreeId: string): boolean {
  return worktreeId.startsWith(PATH_SELECTOR_PREFIX)
}

/** Only this host's exact scratch-root/32-hex folder may answer; reject lookalike roots and symlinks. */
export async function resolveChatScratchSelectorFolder(selector: string): Promise<string | null> {
  if (!selector.startsWith(PATH_SELECTOR_PREFIX)) {
    return null
  }
  const folder = selector.slice(PATH_SELECTOR_PREFIX.length)
  if (dirname(folder) !== chatScratchRoot() || !SCRATCH_FOLDER_NAME.test(basename(folder))) {
    return null
  }
  try {
    return (await lstat(folder)).isDirectory() ? folder : null
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
}
