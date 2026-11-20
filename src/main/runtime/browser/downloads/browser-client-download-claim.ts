// A paired client's download, once the file channel has saved it in the page's workspace here. A
// feature may take it (and must then remove it); nothing else reads these files.
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { BrowserClientDownloadCommit } from './browser-client-download-transfers'

export type CommittedBrowserDownload = {
  browserPageId: string
  /** The committed file's name, after any collision suffix. */
  filename: string
  /** Where the page may be, as this host knows it. */
  urls: readonly string[]
  /** When the transfer began. */
  startedAt: number
  /** The text, or null when it is larger than `maxBytes`. */
  read: (maxBytes: number) => Promise<string | null>
  remove: () => Promise<void>
}

/** Resolves true when it took the download. */
export type CommittedBrowserDownloadClaim = (download: CommittedBrowserDownload) => Promise<boolean>

let claim: CommittedBrowserDownloadClaim | null = null

export function setCommittedBrowserDownloadClaim(next: CommittedBrowserDownloadClaim | null): void {
  claim = next
}

type CommittedDownloadRuntime = {
  resolveRuntimeFileTarget(selector: string): Promise<{ executionHostId: ExecutionHostId }>
  readFileExplorerChunk(
    worktree: string,
    relativePath: string,
    offset: number,
    length: number
  ): Promise<{ contentBase64: string; eof: boolean }>
  deleteFileExplorerPath(
    worktree: string,
    relativePath: string,
    recursive: boolean,
    expectedSshConnectionGeneration: number | undefined,
    expectedSshTargetId: string | undefined,
    expectedExecutionHostId: string
  ): Promise<unknown>
}

/** Offers a committed download to the registered claim; never fails the transfer that saved it. */
export async function offerCommittedBrowserDownload(
  runtime: CommittedDownloadRuntime,
  page: { browserPageId: string; workspaceId: string },
  urls: readonly string[],
  { workspaceRelativePath, startedAt, expectation }: BrowserClientDownloadCommit
): Promise<void> {
  if (!claim) {
    return
  }
  const { workspaceId } = page
  try {
    await claim({
      browserPageId: page.browserPageId,
      filename: workspaceRelativePath.slice(workspaceRelativePath.lastIndexOf('/') + 1),
      urls,
      startedAt,
      read: async (maxBytes) => {
        // The workspace moved hosts since the write: the same path there is another file.
        const { executionHostId } = await runtime.resolveRuntimeFileTarget(workspaceId)
        if (executionHostId !== expectation.expectedExecutionHostId) {
          throw new Error('the download’s host is no longer this workspace’s.')
        }
        const chunk = await runtime.readFileExplorerChunk(
          workspaceId,
          workspaceRelativePath,
          0,
          maxBytes + 1
        )
        const bytes = Buffer.from(chunk.contentBase64, 'base64')
        return bytes.byteLength > maxBytes ? null : bytes.toString('utf8')
      },
      remove: async () => {
        await runtime.deleteFileExplorerPath(
          workspaceId,
          workspaceRelativePath,
          false,
          expectation.expectedSshConnectionGeneration,
          expectation.expectedSshTargetId,
          expectation.expectedExecutionHostId
        )
      }
    })
  } catch (error) {
    console.warn('[browser-downloads] a committed download claim failed', error)
  }
}
