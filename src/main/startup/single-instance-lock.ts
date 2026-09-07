import type { App } from 'electron'
import { argvRequestsServeMode } from './serve-mode-argv'
import { writeStartupDiagnosticLine, type StartupDiagnosticSink } from './startup-diagnostics'

export const SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE =
  '[single-instance] Another Orca instance is already running for this userData profile; exiting this launch after requesting the existing window. If no Orca process is running, this may be an Electron/macOS single-instance lock failure.'
export const SINGLE_INSTANCE_LOCK_BYPASS_ENV = 'ORCA_BYPASS_SINGLE_INSTANCE_LOCK'
export const SINGLE_INSTANCE_LOCK_E2E_ENFORCE_ENV = 'ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK'
export const SINGLE_INSTANCE_LOCK_BYPASS_MESSAGE =
  '[single-instance] ORCA_BYPASS_SINGLE_INSTANCE_LOCK=1 is set; bypassing the packaged macOS single-instance lock for diagnostics. Do not use this with another Orca instance running for the same profile.'
// Why: stable "another process owns this profile" contract that systemd RestartPreventExitStatus= keys off; changing it silently un-fixes #11935.
export const SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE = 3

// Why: a duplicate `orca serve` is a supervisor artifact, not a user asking for a window; fail open when argv is unavailable.
// Why not `argv.includes('--serve')`: the documented systemd unit runs `<binary> serve --port …`, so a
// duplicate start hands this handler CLI-form argv the CLI redirect never rewrote (#12677) — matching only
// the flag form would promote the live headless server to a desktop window, un-fixing #11935.
export function shouldActivateDesktopForSecondInstance(argv: readonly string[] = []): boolean {
  return !argvRequestsServeMode(argv)
}

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
  onSecondInstance: (argv: readonly string[]) => void
): boolean {
  if (!app.requestSingleInstanceLock()) {
    return false
  }
  app.on('second-instance', (_event, argv) => onSecondInstance(argv))
  return true
}

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

export function shouldSkipSingleInstanceLock(options: {
  env?: NodeJS.ProcessEnv
  isDev: boolean
  isServeMode: boolean
}): boolean {
  const env = options.env ?? process.env
  return options.isDev && !options.isServeMode && env[SINGLE_INSTANCE_LOCK_E2E_ENFORCE_ENV] !== '1'
}

export function logSingleInstanceLockFailure(write?: StartupDiagnosticSink): void {
  writeStartupDiagnosticLine(SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE, write)
}

export function logSingleInstanceLockBypass(write?: StartupDiagnosticSink): void {
  writeStartupDiagnosticLine(SINGLE_INSTANCE_LOCK_BYPASS_MESSAGE, write)
}
