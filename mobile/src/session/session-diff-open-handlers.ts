import { useEffect } from 'react'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'

export type SessionDiffOpenHandlers = {
  onFileOpenStart: () => void
  onOpenedFileDiff: (relativePath: string) => void
}

// The session keeps its own tab pick over host snapshots, so a Source Control screen pushed over it must hand opened diffs to it like the dock does.
const handlersBySession = new Map<string, SessionDiffOpenHandlers>()

function sessionKey(hostId: string, executionHost: string | undefined, worktreeId: string): string {
  return JSON.stringify([hostId, executionHost ?? null, worktreeId])
}

export function useProvideSessionDiffOpenHandlers(
  hostId: string,
  worktreeId: string,
  onFileOpenStart: () => void,
  onOpenedFileDiff: (relativePath: string) => void
): void {
  const executionHost = useWorkspaceExecutionHost()
  useEffect(() => {
    const key = sessionKey(hostId, executionHost, worktreeId)
    const handlers = { onFileOpenStart, onOpenedFileDiff }
    handlersBySession.set(key, handlers)
    return () => {
      if (handlersBySession.get(key) === handlers) {
        handlersBySession.delete(key)
      }
    }
  }, [executionHost, hostId, onFileOpenStart, onOpenedFileDiff, worktreeId])
}

export function useSessionDiffOpenHandlers(
  hostId: string | undefined,
  worktreeId: string | undefined
): SessionDiffOpenHandlers | undefined {
  const executionHost = useWorkspaceExecutionHost()
  return hostId && worktreeId
    ? handlersBySession.get(sessionKey(hostId, executionHost, worktreeId))
    : undefined
}
