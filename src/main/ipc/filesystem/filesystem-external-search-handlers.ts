import { ipcMain } from 'electron'
import { getExternalWorkspaceSearchProvider } from '../../search/external-workspace-search-provider'
import { resolveQuickOpenSearchRoot } from '../quick-open-search-root'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

/** IPC for an external local search index. */
export function registerFilesystemExternalSearchHandlers(
  context: Pick<FilesystemHandlerContext, 'store'>
): void {
  const { store } = context
  // True when a local index can rank quick-open paths per query instead of listing them all.
  ipcMain.handle(
    'fs:rankedPathSearch',
    async (
      _event,
      args: { rootPath: string; includeIgnored?: boolean; followSymlinks?: boolean }
    ): Promise<boolean> => {
      const provider = getExternalWorkspaceSearchProvider()
      if (!provider) {
        return false
      }
      try {
        const root = await resolveQuickOpenSearchRoot(args.rootPath, store, undefined)
        if (root.wslDistroForOutput) {
          return false
        }
        return await provider.supportsRankedPathSearch({
          rootPath: root.authorizedRootPath,
          includeIgnored: args.includeIgnored !== false,
          followSymlinks: args.followSymlinks === true
        })
      } catch {
        return false
      }
    }
  )
}
