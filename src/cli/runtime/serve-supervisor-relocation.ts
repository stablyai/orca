/**
 * `orca serve --supervise` re-runs itself from a copy of the CLI outside the app. The CLI loads
 * modules lazily from the app's files, so a desktop update that swaps the app under a running
 * supervisor would otherwise mix two releases' code inside one process. The served child still
 * starts from the app, so it updates as before.
 */
import { createHash } from 'node:crypto'
import { constants, readFileSync, statSync } from 'node:fs'
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
    execve: (file, args, env) => {
      if (!process.execve) {
        throw new Error('this runtime cannot replace its own process')
      }
      process.execve(file, args, env)
    },
    log: (line) => process.stderr.write(`${line}\n`)
  })
}
