import { ipcMain } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import type {
  HostBrowseEntryResolution,
  HostDirectoryListing
} from '../../../shared/filesystem-entry-types'
import { browseServerDirectory } from '../../runtime/runtime-server-environment-commands'

async function canonicalRelativePath(
  realPath: string,
  workspaceRoot: string | undefined,
  canonicalize: (path: string) => Promise<string>
): Promise<string | null> {
  if (!workspaceRoot) {
    return null
  }
  try {
    return relativePathInsideRoot(await canonicalize(workspaceRoot), realPath)
  } catch {
    return null
  }
}

export async function resolveHostBrowseEntry(
  targetPath: string,
  connectionId?: string,
  workspaceRoot?: string
): Promise<HostBrowseEntryResolution> {
  if (targetPath.includes('\0')) {
    throw new Error('Path cannot contain null bytes')
  }
  if (connectionId) {
    // ponytail: no SSH filesystem provider exists since the relay removal (#31922); add an SSH realpath/stat RPC to classify remote entries.
    throw new Error('Remote connection dropped. Click Reconnect on the SSH target before retrying.')
  }
  if (!isAbsolute(targetPath)) {
    throw new Error('Host browse path must be absolute')
  }
  const realPath = await realpath(targetPath)
  const target = await stat(realPath)
  const workspaceRelativePath = await canonicalRelativePath(realPath, workspaceRoot, realpath)
  if (target.isDirectory()) {
    return { kind: 'directory', realPath, workspaceRelativePath }
  }
  if (!target.isFile()) {
    return { kind: 'unsupported', realPath, workspaceRelativePath }
  }
  return { kind: 'file', realPath, workspaceRelativePath }
}

export function registerFilesystemHostBrowseHandlers(): void {
  // Why: names-only listing never touches the external-path allowlist, so browsing
  // outside the workspace grants nothing to later read/write/delete handlers.
  ipcMain.handle(
    'fs:browseHostDir',
    (_event, args: { dirPath: string }): Promise<HostDirectoryListing> =>
      browseServerDirectory(args.dirPath)
  )
  ipcMain.handle(
    'fs:resolveHostBrowseEntry',
    (
      _event,
      args: { targetPath: string; connectionId?: string; workspaceRoot?: string }
    ): Promise<HostBrowseEntryResolution> =>
      resolveHostBrowseEntry(args.targetPath, args.connectionId, args.workspaceRoot)
  )
}
