import type { App } from 'electron'

export const SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE =
  '[single-instance] Another Orca instance is already running for this userData profile; exiting this launch after requesting the existing window. If no Orca process is running, this may be an Electron/macOS single-instance lock failure.'

/**
 * Why: Orca writes two canonical discovery files into `<userData>/`:
 * `orca-runtime.json` (RPC endpoint + authToken for the bundled CLI) and
 * `agent-hooks/endpoint.env` (hook port + token for cursor-agent/claude/codex
 * scripts). Without a single-instance lock, every AppImage/.app double-click
 * boots a fresh Electron main that clobbers both files. When the most recent
 * instance quits, metadata points at a dead pid and `orca status` reports
 * `stale_bootstrap` even though the original process is still running.
 *
 * This helper centralises the lock gate so it is testable in isolation and
 * so `src/main/index.ts` has one clean call site rather than two spread-out
 * Electron calls.
 *
 * Electron derives the lock identity from the current `userData` path, so
 * callers MUST invoke this AFTER `configureDevUserDataPath(is.dev)` — that
 * way dev (`orca-dev` userData) and packaged (`orca` userData) runs lock in
 * separate namespaces instead of serialising against each other.
 */
export function acquireSingleInstanceLock(app: App, onSecondInstance: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    return false
  }
  app.on('second-instance', onSecondInstance)
  return true
}

export function logSingleInstanceLockFailure(logger: Pick<Console, 'error'> = console): void {
  logger.error(SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE)
}
