import { ipcMain } from 'electron'
import type { SearchOptions, SearchResult } from '../../../shared/code-search-types'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { resolveBundledRipgrepWslRouting } from '../../ripgrep/bundled-ripgrep-wsl-routing'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { resolveDesktopAuthorizedPath } from '../local-file-access-resolution'
import { createSenderScopedRequestCancellations } from '../sender-scoped-request-cancellation'
import { stopBundledRipgrep } from '../../ripgrep/bundled-ripgrep-stop'
import { runBundledRipgrepTextSearch } from '../../ripgrep/bundled-ripgrep-text-search'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

export function registerFilesystemContentSearchHandler(context: FilesystemHandlerContext): void {
  const { store, activeTextSearches } = context
  const searches = createSenderScopedRequestCancellations()
  ipcMain.handle('fs:cancelSearch', (event, args: { requestToken: string }) => {
    searches.cancel(event, args.requestToken)
  })

  ipcMain.handle(
    'fs:search',
    async (
      event,
      args: SearchOptions & { connectionId?: string; requestToken?: string }
    ): Promise<SearchResult> => {
      const controller = searches.begin(event, args.requestToken)
      const signal = controller?.signal
      const { requestToken: _requestToken, connectionId: _connectionId, ...options } = args
      try {
        throwIfSignalAborted(signal)
        if (args.connectionId) {
          throw new SshHostNotServedError(args.connectionId)
        }
        const rootPath = await waitForPromiseWithSignal(
          resolveDesktopAuthorizedPath(args.rootPath, store),
          signal
        )
        throwIfSignalAborted(signal)
        const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.rootPath,
          rootPath
        )
        const searchKey = `${event.sender.id}:${rootPath}`
        const { wslDistro, wslDistroForOutput } = resolveBundledRipgrepWslRouting(
          rootPath,
          localGitOptions.wslDistro
        )

        const previousChild = activeTextSearches.get(searchKey)
        if (previousChild) {
          stopBundledRipgrep(previousChild, Boolean(wslDistroForOutput))
        }
        return await runBundledRipgrepTextSearch({
          options,
          rootPath,
          resultRootPath: args.rootPath,
          wslDistro,
          wslDistroForOutput,
          signal,
          onSpawn: (child) => {
            activeTextSearches.set(searchKey, child)
            return () => {
              if (activeTextSearches.get(searchKey) === child) {
                activeTextSearches.delete(searchKey)
              }
            }
          }
        })
      } finally {
        searches.finish(event, args.requestToken, controller)
      }
    }
  )
}
