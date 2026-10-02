import { ipcMain } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import type {
  HostBrowseEntryResolution,
  HostDirectoryListing
} from '../../../shared/filesystem-entry-types'
import { browseServerDirectory } from '../../runtime/runtime-server-environment-commands'
import { requireSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { authorizeExternalPath } from '../filesystem-auth'

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
    // Why: the relay has no FS allowlist (relay/context.ts), so SSH only classifies.
    const provider = requireSshFilesystemProvider(connectionId)
    const realPath = await provider.realpath(targetPath)
    const target = await provider.stat(realPath)
    return {
      kind:
        target.type === 'directory' ? 'directory' : target.type === 'file' ? 'file' : 'unsupported',
      realPath,
      workspaceRelativePath: await canonicalRelativePath(realPath, workspaceRoot, (path) =>
        provider.realpath(path)
      )
    }
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
  // Why: workspace files are already allowed; granting them would only crowd the LRU.
  if (workspaceRelativePath === null) {
    // Why: a rename between stat and grant is accepted; winning it needs local write
    // access that the grant would not add.
    authorizeExternalPath(targetPath)
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
