import type { App } from 'electron'
import { writeStartupDiagnosticLine, type StartupDiagnosticSink } from './startup-diagnostics'

export const SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE =
  '[single-instance] Another Orca instance is already running for this userData profile; exiting this launch after requesting the existing window. If no Orca process is running, this may be an Electron/macOS single-instance lock failure.'
export const SINGLE_INSTANCE_LOCK_BYPASS_ENV = 'ORCA_BYPASS_SINGLE_INSTANCE_LOCK'
export const SINGLE_INSTANCE_LOCK_BYPASS_MESSAGE =
  '[single-instance] ORCA_BYPASS_SINGLE_INSTANCE_LOCK=1 is set; bypassing the packaged macOS single-instance lock for diagnostics. Do not use this with another Orca instance running for the same profile.'

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
export function acquireSingleInstanceLock(
  app: App,
  onSecondInstance: (argv: string[]) => void
): boolean {
  if (!app.requestSingleInstanceLock()) {
    return false
  }
  // Why: forward the second launch's argv so Windows/Linux protocol activations
  // (`orca://…` arrives as an argv entry, not an event) can be routed by the
  // handler. macOS delivers the same intent via `open-url` instead.
  app.on('second-instance', (_event, argv) => onSecondInstance(argv))
  return true
}

/**
 * Decide whether to skip the packaged single-instance lock. Only ever true on a
 * packaged macOS build with `ORCA_BYPASS_SINGLE_INSTANCE_LOCK=1` set — a
 * diagnostics-only escape hatch. Dev and serve-mode runs, and every non-darwin
 * platform, always keep the lock. `env` and `platform` are injectable for tests.
 */
export function shouldBypassSingleInstanceLock(options: {
  env?: NodeJS.ProcessEnv
  isDev: boolean
  isServeMode: boolean
  platform?: NodeJS.Platform
}): boolean {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  return (
    platform === 'darwin' &&
    !options.isDev &&
    !options.isServeMode &&
    env[SINGLE_INSTANCE_LOCK_BYPASS_ENV] === '1'
  )
}

/**
 * Emit the canonical lock-failure diagnostic (this launch could not acquire the
 * single-instance lock and is exiting) through the startup diagnostic sink.
 */
export function logSingleInstanceLockFailure(write?: StartupDiagnosticSink): void {
  writeStartupDiagnosticLine(SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE, write)
}

/**
 * Emit the diagnostic noting that the packaged macOS single-instance lock is
 * being bypassed via `ORCA_BYPASS_SINGLE_INSTANCE_LOCK`.
 */
export function logSingleInstanceLockBypass(write?: StartupDiagnosticSink): void {
  writeStartupDiagnosticLine(SINGLE_INSTANCE_LOCK_BYPASS_MESSAGE, write)
}
