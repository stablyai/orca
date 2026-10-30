import { BrowserClientDownloadTransferStore } from './browser-client-download-transfers'

type RuntimeFileChannelHost = {
  writeFileExplorerFileBase64Chunk(
    worktree: string,
    relativePath: string,
    contentBase64: string,
    append: boolean
  ): Promise<unknown>
  commitFileExplorerUpload(
    worktree: string,
    tempRelativePath: string,
    finalRelativePath: string
  ): Promise<unknown>
  deleteFileExplorerPath(
    worktree: string,
    relativePath: string,
    recursive?: boolean
  ): Promise<unknown>
  createFileExplorerDir(worktree: string, relativePath: string): Promise<unknown>
  statRuntimeFile(worktree: string, relativePath: string): Promise<unknown>
}

// Lease cleanup knows only the runtime id; file-channel hosts create the store.
type DownloadTransferRuntime = RuntimeFileChannelHost | { getRuntimeId(): string }

const stores = new WeakMap<DownloadTransferRuntime, BrowserClientDownloadTransferStore>()

/** Clean staged downloads during retirement/fencing even after transport loss; no-op without a store. */
export function releaseBrowserClientDownloadTransfersForPage(
  runtime: DownloadTransferRuntime,
  browserPageId: string,
  pageHostGeneration?: number
): Promise<void> {
  return stores.get(runtime)?.releasePage(browserPageId, pageHostGeneration) ?? Promise.resolve()
}

export function getBrowserClientDownloadTransferStore(
  runtime: RuntimeFileChannelHost
): BrowserClientDownloadTransferStore {
  let store = stores.get(runtime)
  if (!store) {
    store = new BrowserClientDownloadTransferStore({
      writeChunk: async ({ workspaceId, relativePath, contentBase64, append }) => {
        await runtime.writeFileExplorerFileBase64Chunk(
          workspaceId,
          relativePath,
          contentBase64,
          append
        )
      },
      commit: async ({ workspaceId, tempRelativePath, finalRelativePath }) => {
        await runtime.commitFileExplorerUpload(workspaceId, tempRelativePath, finalRelativePath)
      },
      remove: async ({ workspaceId, relativePath }) => {
        await runtime.deleteFileExplorerPath(workspaceId, relativePath, false)
      },
      ensureDirectory: async ({ workspaceId, relativePath }) => {
        await runtime.createFileExplorerDir(workspaceId, relativePath)
      },
      exists: async ({ workspaceId, relativePath }) => {
        try {
          await runtime.statRuntimeFile(workspaceId, relativePath)
          return true
        } catch {
          return false
        }
      }
    })
    stores.set(runtime, store)
  }
  return store
}
