import { useEffect, useRef } from 'react'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'

export type SessionScreenHandlers = {
  onFileOpenStart: () => void
  onOpenedFileDiff: (relativePath: string) => void
  onResumedTerminal: (handle: string) => void
}

// The session keeps its own tab pick over host snapshots, so a screen pushed over it must hand opened diffs and resumed terminals to it like the dock does.
// A stack per key: the same worktree's session can be pushed twice; the top one owns them.
const handlersBySession = new Map<string, SessionScreenHandlers[]>()

function sessionKey(hostId: string, executionHost: string | undefined, worktreeId: string): string {
  return JSON.stringify([hostId, executionHost ?? null, worktreeId])
}

export function useProvideSessionScreenHandlers(
  hostId: string,
  worktreeId: string,
  current: SessionScreenHandlers
): void {
  const executionHost = useWorkspaceExecutionHost()
  const { onFileOpenStart, onOpenedFileDiff, onResumedTerminal } = current
  const latestRef = useRef(current)
  useEffect(() => {
    latestRef.current = { onFileOpenStart, onOpenedFileDiff, onResumedTerminal }
  }, [onFileOpenStart, onOpenedFileDiff, onResumedTerminal])
  // Register once per mount so a lower session's new callbacks cannot jump it above the visible one.
  useEffect(() => {
    const key = sessionKey(hostId, executionHost, worktreeId)
    const handlers: SessionScreenHandlers = {
      onFileOpenStart: () => latestRef.current.onFileOpenStart(),
      onOpenedFileDiff: (relativePath) => latestRef.current.onOpenedFileDiff(relativePath),
      onResumedTerminal: (handle) => latestRef.current.onResumedTerminal(handle)
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

export function useSessionScreenHandlers(
  hostId: string | undefined,
  worktreeId: string | undefined
): SessionScreenHandlers | undefined {
  const executionHost = useWorkspaceExecutionHost()
  return hostId && worktreeId
    ? handlersBySession.get(sessionKey(hostId, executionHost, worktreeId))?.at(-1)
    : undefined
}
