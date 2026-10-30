import type { App } from 'electron'
import { argvRequestsServeMode } from './serve-mode-argv'
import { writeStartupDiagnosticLine, type StartupDiagnosticSink } from './startup-diagnostics'

export const SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE =
  '[single-instance] Another Orca instance is already running for this userData profile; exiting this launch after requesting the existing window. If no Orca process is running, this may be an Electron/macOS single-instance lock failure.'
export const SINGLE_INSTANCE_LOCK_BYPASS_ENV = 'ORCA_BYPASS_SINGLE_INSTANCE_LOCK'
export const SINGLE_INSTANCE_LOCK_E2E_ENFORCE_ENV = 'ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK'
export const SINGLE_INSTANCE_LOCK_BYPASS_MESSAGE =
  '[single-instance] ORCA_BYPASS_SINGLE_INSTANCE_LOCK=1 is set; bypassing the packaged macOS single-instance lock for diagnostics. Do not use this with another Orca instance running for the same profile.'
export { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from '../../shared/single-instance-exit-code'

// Supervisor duplicate serve launches must not activate desktop; recognize CLI-form argv too (#12677, #11935). Missing argv preserves activation.
export function shouldActivateDesktopForSecondInstance(argv: readonly string[] = []): boolean {
  return !argvRequestsServeMode(argv)
}

/** Duplicate mains clobber runtime/hook discovery files and leave stale_bootstrap after exit. Acquire after userData overrides so dev/packaged instances lock distinct profile namespaces. */
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

// Only disposable E2E profiles skip by default; concurrent dev desktops still corrupt stores without locking.
export function shouldSkipSingleInstanceLock(options: {
  env?: NodeJS.ProcessEnv
  isDev: boolean
  isServeMode: boolean
}): boolean {
  const env = options.env ?? process.env
  return (
    options.isDev &&
    !options.isServeMode &&
    Boolean(env.ORCA_E2E_USER_DATA_DIR) &&
    env[SINGLE_INSTANCE_LOCK_E2E_ENFORCE_ENV] !== '1'
  )
}

export function singleInstanceLockFailureMessage(options: {
  isDevDesktop: boolean
  userDataPath: string
}): string {
  if (!options.isDevDesktop) {
    return SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE
  }
  return `[single-instance] Another Orca dev instance is already running on the profile at ${options.userDataPath}; exiting this launch after passing it this launch's request. To run another dev copy at the same time, give it its own profile: \`pnpm dev --worktree-profile\` (the default in linked worktrees) or ORCA_DEV_USER_DATA_PATH=<another directory> pnpm dev`
}

export function logSingleInstanceLockFailure(
  options: { isDevDesktop: boolean; userDataPath: string },
  write?: StartupDiagnosticSink
): void {
  writeStartupDiagnosticLine(singleInstanceLockFailureMessage(options), write)
}

export function logSingleInstanceLockBypass(write?: StartupDiagnosticSink): void {
  writeStartupDiagnosticLine(SINGLE_INSTANCE_LOCK_BYPASS_MESSAGE, write)
}
