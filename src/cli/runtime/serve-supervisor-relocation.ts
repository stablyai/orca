/**
 * `orca serve --supervise` re-runs itself from a copy of the CLI outside the app. The CLI loads
 * modules lazily from the app's files, so a desktop update that swaps the app under a running
 * supervisor would otherwise mix two releases' code inside one process. The served child still
 * starts from the app, so it updates as before.
 */
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isProcessAlive } from '../../shared/serve-bundle-coordination'

/** Set on the re-run supervisor: the app root its own `__dirname` no longer points at. */
export const SERVE_SUPERVISOR_APP_ROOT_ENV = 'ORCA_SERVE_SUPERVISOR_APP_ROOT'

const PACKAGED_APP_ROOT_NAME = 'app.asar.unpacked'
const COMPLETE_MARKER = '.complete'
const USERS_DIR = '.users'
const TEMPORARY_PREFIX = '.tmp-'

export type SupervisorRelocationDeps = {
  env: NodeJS.ProcessEnv
  execPath: string
  argv: string[]
  /** Where this CLI runs from: `<Resources>/app.asar.unpacked` in a packaged app. */
  appRoot: string
  userDataPath: string
  pid: number
  isProcessAlive: (pid: number) => boolean
  execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => void
  log: (line: string) => void
}

export function serveSupervisorSnapshotRoot(userDataPath: string): string {
  return join(userDataPath, 'serve-supervisor')
}

/** One copy per release: the compiled package stamp names version and commit. */
function snapshotId(appRoot: string, execPath: string): string {
  const hash = createHash('sha256')
  try {
    hash.update(readFileSync(join(appRoot, 'out', 'package.json')))
  } catch {
    hash.update('no-package')
  }
  try {
    const executable = statSync(execPath)
    hash.update(`|${executable.size}:${Math.trunc(executable.mtimeMs)}`)
  } catch {
    hash.update('|missing')
  }
  return hash.digest('hex').slice(0, 24)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** Who runs from each copy, kept beside the copies so it never blocks publishing one. */
const usersDir = (root: string, id: string): string => join(root, USERS_DIR, id)

async function buildSnapshot(
  resources: string,
  root: string,
  id: string,
  pid: number
): Promise<void> {
  // Why mark before checking: another supervisor's cleanup keeps any copy with a live user.
  await mkdir(usersDir(root, id), { recursive: true })
  await writeFile(join(usersDir(root, id), String(pid)), '')
  const snapshotDir = join(root, id)
  if (await exists(join(snapshotDir, COMPLETE_MARKER))) {
    return
  }
  const temporary = join(root, `${TEMPORARY_PREFIX}${pid}-${id}`)
  await rm(temporary, { recursive: true, force: true })
  try {
    // Why both: bare requires from out/ walk up into Resources/node_modules.
    for (const name of [PACKAGED_APP_ROOT_NAME, 'node_modules']) {
      if (await exists(join(resources, name))) {
        // Why FICLONE: on APFS and reflink filesystems the copy shares blocks with the app.
        await cp(join(resources, name), join(temporary, name), {
          recursive: true,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE
        })
      }
    }
    await writeFile(join(temporary, COMPLETE_MARKER), '')
  } catch (error) {
    // Why: a partial copy on a full disk would otherwise keep that space for the service's life.
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  try {
    await rename(temporary, snapshotDir)
  } catch (error) {
    // Another supervisor of this profile finished the same release first.
    await rm(temporary, { recursive: true, force: true })
    if (!(await exists(join(snapshotDir, COMPLETE_MARKER)))) {
      throw error
    }
  }
}

function isLivePidName(name: string, isProcessAlive: (pid: number) => boolean): boolean {
  const pid = Number(name)
  return Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)
}

async function removeUnusedSnapshots(
  root: string,
  keep: string,
  isProcessAlive: (pid: number) => boolean
): Promise<void> {
  for (const name of await readdir(root).catch(() => [])) {
    if (name === keep || name === USERS_DIR) {
      continue
    }
    const inUse = name.startsWith(TEMPORARY_PREFIX)
      ? isLivePidName(name.slice(TEMPORARY_PREFIX.length).split('-')[0], isProcessAlive)
      : (await readdir(usersDir(root, name)).catch(() => [])).some((pid) =>
          isLivePidName(pid, isProcessAlive)
        )
    if (!inUse) {
      await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined)
      await rm(usersDir(root, name), { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/**
 * An AppImage's files are its own mount (or extracted copy) for the whole run, so no update can
 * swap them. Re-exec from node mode would also close the runtime's keepalive pipe, which unmounts
 * the AppImage under the exec and leaves the new image unable to load its libraries.
 */
function runsFromAppImage(appRoot: string, env: NodeJS.ProcessEnv): boolean {
  const appDir = env.APPDIR
  if (!appDir || !isAbsolute(appDir)) {
    return false
  }
  const inside = relative(resolve(appDir), resolve(appRoot))
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
}

/**
 * Resolves only when the supervisor keeps running from where it is; a successful re-run replaces
 * this process (same pid, so the service manager keeps tracking it) and never returns.
 */
export async function relocateServeSupervisor(
  deps: SupervisorRelocationDeps
): Promise<'in-place' | 'already-relocated' | 'relocated'> {
  if (deps.env[SERVE_SUPERVISOR_APP_ROOT_ENV]) {
    return 'already-relocated'
  }
  // Why packaged only: a dev or overridden executable has no app swapped under it by an update.
  const override = deps.env.ORCA_APP_EXECUTABLE
  if (
    deps.env.ELECTRON_RUN_AS_NODE !== '1' ||
    (typeof override === 'string' && override.trim().length > 0) ||
    basename(deps.appRoot) !== PACKAGED_APP_ROOT_NAME ||
    runsFromAppImage(deps.appRoot, deps.env)
  ) {
    return 'in-place'
  }
  const root = serveSupervisorSnapshotRoot(deps.userDataPath)
  const id = snapshotId(deps.appRoot, deps.execPath)
  const cliEntry = join(root, id, PACKAGED_APP_ROOT_NAME, 'out', 'cli', 'index.js')
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await buildSnapshot(dirname(deps.appRoot), root, id, deps.pid)
    await removeUnusedSnapshots(root, id, deps.isProcessAlive)
  } catch (error) {
    deps.log(
      `[serve] Supervising from the app itself; could not copy it aside: ${error instanceof Error ? error.message : String(error)}`
    )
    return 'in-place'
  }
  try {
    deps.execve(deps.execPath, [deps.execPath, cliEntry, ...deps.argv.slice(2)], {
      ...deps.env,
      [SERVE_SUPERVISOR_APP_ROOT_ENV]: deps.appRoot
    })
  } catch (error) {
    deps.log(
      `[serve] Supervising from the app itself; could not restart from the copy: ${error instanceof Error ? error.message : String(error)}`
    )
    return 'in-place'
  }
  return 'relocated'
}

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

let startedFromExecutable: string | null = null

/** Remembers which executable this supervisor process started from, before any update wait. */
export function noteServeSupervisorStart(): void {
  startedFromExecutable = fileIdentity(process.execPath)
}

export type SupervisorRestartDeps = Pick<
  SupervisorRelocationDeps,
  'env' | 'execPath' | 'argv' | 'appRoot' | 'pid' | 'execve' | 'log'
> & {
  execArgv: string[]
  /** Identity of `execPath` when this process started. */
  startedFrom: string | null
  identify: (path: string) => string | null
  canExecute: (path: string) => boolean
}

/**
 * Re-runs this supervisor in place when an update replaced the executable it started from, so no
 * process keeps running deleted files. A relocated supervisor restarts from the app's CLI so it
 * copies the new release aside. Returns only when it did not restart.
 */
export function restartServeSupervisorIfReplaced(deps: SupervisorRestartDeps): void {
  const installed = deps.identify(deps.execPath)
  // Why: after a restart the start identity is the installed one, so this never loops.
  if (!deps.startedFrom || !installed || installed === deps.startedFrom) {
    return
  }
  const env = { ...deps.env }
  const relocated = Boolean(env[SERVE_SUPERVISOR_APP_ROOT_ENV])
  delete env[SERVE_SUPERVISOR_APP_ROOT_ENV]
  const cliEntry = relocated ? join(deps.appRoot, 'out', 'cli', 'index.js') : deps.argv[1]
  // Why preflight: a failed process.execve aborts the process natively instead of throwing.
  if (!deps.canExecute(deps.execPath) || !existsSync(cliEntry)) {
    deps.log('[serve] Starting the update from here; the installed app is not ready to run.')
    return
  }
  if (relocated) {
    // Why: the copy's cleanup keeps any copy a live pid is marked on, and this pid is leaving it.
    const snapshotDir = resolve(deps.argv[1], '..', '..', '..', '..')
    rmSync(join(usersDir(dirname(snapshotDir), basename(snapshotDir)), String(deps.pid)), {
      force: true
    })
  }
  try {
    deps.execve(
      deps.execPath,
      [deps.execPath, ...deps.execArgv, cliEntry, ...deps.argv.slice(2)],
      env
    )
  } catch (error) {
    // Only a runtime without process.execve gets here.
    deps.log(
      `[serve] Starting the update from here; could not restart from the installed app: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function execveThisProcess(file: string, args: string[], env: NodeJS.ProcessEnv): void {
  if (!process.execve) {
    throw new Error('this runtime cannot replace its own process')
  }
  process.execve(file, args, env)
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
    startedFrom: startedFromExecutable,
    identify: fileIdentity,
    canExecute: isExecutable
  })
}

export function relocateThisServeSupervisor(
  appRoot: string,
  userDataPath: string
): ReturnType<typeof relocateServeSupervisor> {
  return relocateServeSupervisor({
    env: process.env,
    execPath: process.execPath,
    argv: process.argv,
    appRoot,
    userDataPath,
    pid: process.pid,
    isProcessAlive,
    execve: execveThisProcess,
    log: (line) => process.stderr.write(`${line}\n`)
  })
}
