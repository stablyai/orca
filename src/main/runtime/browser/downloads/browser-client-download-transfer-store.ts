import type { ExecutionHostId } from '../../../../shared/execution-host'
import { BrowserClientDownloadTransferStore } from './browser-client-download-transfers'
import {
  captureRuntimeFileMutationExpectation,
  type RuntimeFileMutationExpectation
} from '../../files/file-mutation-expectation'

type ExpectationArgs = [
  expectedSshConnectionGeneration: number | undefined,
  expectedSshTargetId: string | undefined,
  expectedExecutionHostId: string
]

type RuntimeFileChannelHost = {
  resolveRuntimeFileTarget(selector: string): Promise<{ executionHostId: ExecutionHostId }>
  writeFileExplorerFileBase64Chunk(
    worktree: string,
    relativePath: string,
    contentBase64: string,
    append: boolean,
    ...expectation: ExpectationArgs
  ): Promise<unknown>
  commitFileExplorerUpload(
    worktree: string,
    tempRelativePath: string,
    finalRelativePath: string,
    ...expectation: ExpectationArgs
  ): Promise<unknown>
  deleteFileExplorerPath(
    worktree: string,
    relativePath: string,
    recursive: boolean,
    ...expectation: ExpectationArgs
  ): Promise<unknown>
  createFileExplorerDir(
    worktree: string,
    relativePath: string,
    ...expectation: ExpectationArgs
  ): Promise<unknown>
  statRuntimeFile(worktree: string, relativePath: string): Promise<unknown>
}

function expectationArgs(expectation: RuntimeFileMutationExpectation): ExpectationArgs {
  return [
    expectation.expectedSshConnectionGeneration,
    expectation.expectedSshTargetId,
    expectation.expectedExecutionHostId
  ]
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
      // The server is the writer: pin the workspace's current host for the whole transfer.
      prepareDirectory: async (workspaceId, relativePath) => {
        const expectation = captureRuntimeFileMutationExpectation(
          (await runtime.resolveRuntimeFileTarget(workspaceId)).executionHostId
        )
        await runtime.createFileExplorerDir(
          workspaceId,
          relativePath,
          ...expectationArgs(expectation)
        )
        return expectation
      },
      writeChunk: async ({ workspaceId, expectation, relativePath, contentBase64, append }) => {
        await runtime.writeFileExplorerFileBase64Chunk(
          workspaceId,
          relativePath,
          contentBase64,
          append,
          ...expectationArgs(expectation)
        )
      },
      commit: async ({ workspaceId, expectation, tempRelativePath, finalRelativePath }) => {
        await runtime.commitFileExplorerUpload(
          workspaceId,
          tempRelativePath,
          finalRelativePath,
          ...expectationArgs(expectation)
        )
      },
      remove: async ({ workspaceId, expectation, relativePath }) => {
        await runtime.deleteFileExplorerPath(
          workspaceId,
          relativePath,
          false,
          ...expectationArgs(expectation)
        )
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
