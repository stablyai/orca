import type { LegacyMobileFileEntry } from './file-list-fallback'
import type { MobileDirEntry } from './file-tree'

export type HostFileExplorerDirectoryResult =
  | {
      kind: 'directory'
      entries: MobileDirEntry[]
      truncated: boolean
    }
  | {
      kind: 'legacy-list'
      files: LegacyMobileFileEntry[]
      truncated: boolean
    }

export type HostFileExplorerOperations = {
  readDirectory(workspaceId: string, relativePath: string): Promise<HostFileExplorerDirectoryResult>
  reconnect(): Promise<void>
}
