/**
 * macOS charges the permissions of every process a launchd-started supervisor spawns to that
 * supervisor, so once an update deletes the app it runs from, no server may start under it. Before
 * each server starts, a supervisor whose executable was replaced re-runs itself in place (same pid)
 * from the installed app.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  execveThisProcess,
  releaseServeSupervisorSnapshot,
  SERVE_SUPERVISOR_APP_ROOT_ENV,
  type SupervisorRelocationDeps
} from './serve-supervisor-relocation'

/** `dev:ino` of a file, which changes when an update replaces the app; null if unreadable. */
function fileIdentity(path: string): string | null {
  try {
    const stats = statSync(path)
    return `${stats.dev}:${stats.ino}`
  } catch {
    return null
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Why process state: the first server may start long after an update wait or a park.
let startedFrom: string | null = null

export function noteServeSupervisorStart(): void {
  startedFrom = fileIdentity(process.execPath)
}

export type ReplacedAppRestartDeps = Pick<
  SupervisorRelocationDeps,
  'env' | 'execPath' | 'argv' | 'appRoot' | 'pid' | 'execve' | 'log'
> & { execArgv: string[]; startedFrom: string | null }

/** Returns only when it did not restart. */
export function restartServeSupervisorIfReplaced(deps: ReplacedAppRestartDeps): void {
  const installed = fileIdentity(deps.execPath)
  // Why: after a restart the start identity is the installed one, so this never loops.
  if (!deps.startedFrom || !installed || installed === deps.startedFrom) {
    return
  }
  const env = { ...deps.env }
  const relocated = Boolean(env[SERVE_SUPERVISOR_APP_ROOT_ENV])
  delete env[SERVE_SUPERVISOR_APP_ROOT_ENV]
  // Why the app's CLI: a relocated supervisor must copy the new release aside, not rerun the old copy.
  const cliEntry = relocated ? join(deps.appRoot, 'out', 'cli', 'index.js') : deps.argv[1]
  // Why preflight: a failed process.execve aborts the process natively instead of throwing.
  if (!isExecutable(deps.execPath) || !existsSync(cliEntry)) {
    deps.log('[serve] Keeping the old executable; the installed app is not ready to run.')
    return
  }
  if (relocated) {
    releaseServeSupervisorSnapshot(deps.argv[1], deps.pid)
  }
  try {
    deps.execve(
      deps.execPath,
      [deps.execPath, ...deps.execArgv, cliEntry, ...deps.argv.slice(2)],
      env
    )
  } catch (error) {
    deps.log(
      `[serve] Keeping the old executable; could not restart from the installed app: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function restartThisServeSupervisorIfReplaced(appRoot: string): void {
  restartServeSupervisorIfReplaced({
    env: process.env,
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    appRoot,
    pid: process.pid,
    execve: execveThisProcess,
    log: (line) => process.stderr.write(`${line}\n`),
    startedFrom
  })
}
