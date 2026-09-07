import type { ChildProcess } from 'node:child_process'
import type { FileHandle } from 'node:fs/promises'
import type { Store } from '../../persistence'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/commit-message-agent-environment'
import type { SenderScopedRequestCancellations } from '../sender-scoped-request-cancellation'
import { cleanupLocalTransferPath } from './filesystem-download-promotion'

export type DownloadSession = {
  destinationPath: string
  tempPath: string
  destinationExisted: boolean
  handle: FileHandle
  cleanupTimer: ReturnType<typeof setTimeout>
  senderId: number
}

export type FilesystemHandlerContext = {
  store: Store
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
  activeTextSearches: Map<string, ChildProcess>
  downloadSessions: Map<string, DownloadSession>
  listFilesCancellations: SenderScopedRequestCancellations
  gitStatusCancellations: SenderScopedRequestCancellations
  closeDownloadSession: (
    transferId: string,
    cleanupTemp: boolean
  ) => Promise<DownloadSession | null>
  cleanupDownloadSessionsForSender: (senderId: number) => void
}

export function createFilesystemHandlerContext(
  store: Store,
  commitMessageAgentEnv: CommitMessageAgentEnvironmentResolvers | undefined,
  listFilesCancellations: SenderScopedRequestCancellations,
  gitStatusCancellations: SenderScopedRequestCancellations
): FilesystemHandlerContext {
  const activeTextSearches = new Map<string, ChildProcess>()
  const downloadSessions = new Map<string, DownloadSession>()

  const closeDownloadSession = async (
    transferId: string,
    cleanupTemp: boolean
  ): Promise<DownloadSession | null> => {
    const session = downloadSessions.get(transferId)
    if (!session) {
      return null
    }
    downloadSessions.delete(transferId)
    clearTimeout(session.cleanupTimer)
    await session.handle.close().catch(() => {})
    if (cleanupTemp) {
      await cleanupLocalTransferPath(session.tempPath)
    }
    return session
  }

  const cleanupDownloadSessionsForSender = (senderId: number): void => {
    for (const [transferId, session] of Array.from(downloadSessions)) {
      if (session.senderId === senderId) {
        void closeDownloadSession(transferId, true)
      }
    }
  }

  return {
    store,
    commitMessageAgentEnv,
    activeTextSearches,
    downloadSessions,
    listFilesCancellations,
    gitStatusCancellations,
    closeDownloadSession,
    cleanupDownloadSessionsForSender
  }
}
