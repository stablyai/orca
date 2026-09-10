import type { RpcClient } from '../transport/rpc-client'
import { isMobileMethodUnavailableError, type LegacyFilesListResult } from './file-list-fallback'
import type {
  HostFileExplorerDirectoryResult,
  HostFileExplorerOperations
} from './host-file-explorer-operations'
import type { MobileDirEntry } from './file-tree'

export function nativeHostFileExplorerOperations(client: RpcClient): HostFileExplorerOperations {
  return {
    async readDirectory(workspaceId, relativePath) {
      const response = await client.sendRequest('files.readDir', {
        worktree: `id:${workspaceId}`,
        relativePath
      })
      if (response.ok) {
        return {
          kind: 'directory',
          entries: response.result as MobileDirEntry[]
        }
      }
      // Why: desktops that predate the files.readDir mobile allowlist entry still serve the
      // capped files.list; fall back so the Files tab keeps working until the desktop updates.
      if (
        relativePath === '' &&
        isMobileMethodUnavailableError(response.error?.code, response.error?.message)
      ) {
        return readLegacyFileList(client, workspaceId, response.error?.message)
      }
      throw new Error(response.error?.message || 'Unable to load files')
    }
  }
}

async function readLegacyFileList(
  client: RpcClient,
  workspaceId: string,
  readDirectoryMessage: string | undefined
): Promise<HostFileExplorerDirectoryResult> {
  const response = await client.sendRequest('files.list', {
    worktree: `id:${workspaceId}`
  })
  if (!response.ok) {
    throw new Error(response.error?.message || readDirectoryMessage || 'Unable to load files')
  }
  const result = response.result as LegacyFilesListResult
  return {
    kind: 'legacy-list',
    files: result.files,
    truncated: result.truncated
  }
}
