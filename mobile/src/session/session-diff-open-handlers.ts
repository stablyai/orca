import { useEffect, useRef } from 'react'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'

export type SessionDiffOpenHandlers = {
  onFileOpenStart: () => void
  onOpenedFileDiff: (relativePath: string) => void
}

// The session keeps its own tab pick over host snapshots, so a Source Control screen pushed over it must hand opened diffs to it like the dock does.
// A stack per key: the same worktree's session can be pushed twice (e.g. resume from Agent History); the top one owns Changes.
const handlersBySession = new Map<string, SessionDiffOpenHandlers[]>()

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
  const latestRef = useRef({ onFileOpenStart, onOpenedFileDiff })
  useEffect(() => {
    latestRef.current = { onFileOpenStart, onOpenedFileDiff }
  }, [onFileOpenStart, onOpenedFileDiff])
  // Register once per mount so a lower session's new callbacks cannot jump it above the visible one.
  useEffect(() => {
    const key = sessionKey(hostId, executionHost, worktreeId)
    const handlers: SessionDiffOpenHandlers = {
      onFileOpenStart: () => latestRef.current.onFileOpenStart(),
      onOpenedFileDiff: (relativePath) => latestRef.current.onOpenedFileDiff(relativePath)
    }
    handlersBySession.set(key, [...(handlersBySession.get(key) ?? []), handlers])
    return () => {
      const remaining = (handlersBySession.get(key) ?? []).filter((entry) => entry !== handlers)
      if (remaining.length > 0) {
        handlersBySession.set(key, remaining)
      } else {
        handlersBySession.delete(key)
      }
    }
  }, [executionHost, hostId, worktreeId])
}

export function useSessionDiffOpenHandlers(
  hostId: string | undefined,
  worktreeId: string | undefined
): SessionDiffOpenHandlers | undefined {
  const executionHost = useWorkspaceExecutionHost()
  return hostId && worktreeId
    ? handlersBySession.get(sessionKey(hostId, executionHost, worktreeId))?.at(-1)
    : undefined
}
