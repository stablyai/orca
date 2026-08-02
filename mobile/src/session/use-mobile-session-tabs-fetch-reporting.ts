import { useMemo, type MutableRefObject } from 'react'
import type { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'

type DiagnosticTabsSnapshot = Parameters<MobileTerminalDiagnostics['tabsFetchSucceeded']>[0]

/** Forwards session-tabs fetch outcomes to the screen's diagnostics recorder.
 *  Split out of the session route so the reconciliation wiring there stays a
 *  single call rather than five one-line callbacks. */
export function useMobileSessionTabsFetchReporting<Result extends DiagnosticTabsSnapshot>(args: {
  worktreeId: string
  diagnosticsRef: MutableRefObject<MobileTerminalDiagnostics>
}): {
  onFetchStarted: () => void
  onFetchSucceeded: (result: Result) => void
  onFetchFailed: (code: string) => void
  onFetchErrored: (error: unknown) => void
} {
  const { worktreeId, diagnosticsRef } = args
  return useMemo(
    () => ({
      onFetchStarted: () => diagnosticsRef.current.tabsFetchStarted(worktreeId),
      onFetchSucceeded: (result: Result) => diagnosticsRef.current.tabsFetchSucceeded(result),
      onFetchFailed: (code: string) => diagnosticsRef.current.tabsFetchFailed(code),
      onFetchErrored: (error: unknown) => diagnosticsRef.current.tabsFetchErrored(error)
    }),
    [diagnosticsRef, worktreeId]
  )
}
