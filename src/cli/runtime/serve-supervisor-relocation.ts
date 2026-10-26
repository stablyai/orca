/** Copy supervisors outside the app so updates cannot mix lazily loaded modules from two releases. */
import { createHash } from 'node:crypto'
import { constants, readFileSync, rmSync, statSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { cloneMacTree } from '../../main/macos-tree-clone'
import { isProcessAlive } from '../../shared/serve-bundle-coordination'

/** Relocated supervisors can no longer derive the app root from __dirname. */
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

/** Keep PID claims outside snapshots so they cannot block publication. */
const usersDir = (root: string, id: string): string => join(root, USERS_DIR, id)

async function copyTree(source: string, destination: string): Promise<void> {
  // macOS cp -c clones a tree faster than fs.cp’s per-file cloning.
  if (process.platform === 'darwin') {
    return cloneMacTree(source, destination)
  }
  // Share app blocks on reflink filesystems.
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE
  })
}

async function buildSnapshot(
  resources: string,
  root: string,
  id: string,
  pid: number
): Promise<void> {
  // Claim before checking so concurrent cleanup preserves this snapshot.
  await mkdir(usersDir(root, id), { recursive: true })
  await writeFile(join(usersDir(root, id), String(pid)), '')
  const snapshotDir = join(root, id)
  if (await exists(join(snapshotDir, COMPLETE_MARKER))) {
    return
  }
  const temporary = join(root, `${TEMPORARY_PREFIX}${pid}-${id}`)
  await rm(temporary, { recursive: true, force: true })
  try {
    await mkdir(temporary)
    // Bare requires from out/ resolve through Resources/node_modules.
    for (const name of [PACKAGED_APP_ROOT_NAME, 'node_modules']) {
      if (await exists(join(resources, name))) {
        await copyTree(join(resources, name), join(temporary, name))
      }
    }
    await writeFile(join(temporary, COMPLETE_MARKER), '')
  } catch (error) {
    // Failed copies must not retain disk space for the service’s lifetime.
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

/** AppImages keep stable files; re-exec would close their keepalive pipe and release the mount. */
function runsFromAppImage(appRoot: string, env: NodeJS.ProcessEnv): boolean {
  const appDir = env.APPDIR
  if (!appDir || !isAbsolute(appDir)) {
    return false
  }
  const inside = relative(resolve(appDir), resolve(appRoot))
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
}

/** A successful relocation replaces this process at the same PID and never returns. */
export async function relocateServeSupervisor(
  deps: SupervisorRelocationDeps
): Promise<'in-place' | 'already-relocated' | 'relocated'> {
  if (deps.env[SERVE_SUPERVISOR_APP_ROOT_ENV]) {
    return 'already-relocated'
  }
  // Dev and overridden executables are not swapped by app updates.
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

/** Releases `pid`'s claim on the copy it runs `cliEntry` from, so cleanup can remove that copy. */
export function releaseServeSupervisorSnapshot(cliEntry: string, pid: number): void {
  const snapshotDir = resolve(cliEntry, '..', '..', '..', '..')
  rmSync(join(usersDir(dirname(snapshotDir), basename(snapshotDir)), String(pid)), { force: true })
}

export function execveThisProcess(file: string, args: string[], env: NodeJS.ProcessEnv): void {
  if (!process.execve) {
    throw new Error('this runtime cannot replace its own process')
  }
  process.execve(file, args, env)
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
