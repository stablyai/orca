/** Copy supervisors outside the app so updates cannot mix lazily loaded modules from two releases. */
import { createHash } from 'node:crypto'
import { constants, readFileSync, rmSync, statSync } from 'node:fs'
import { cp, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { cloneMacTree } from '../../main/macos-tree-clone'
import { isProcessAlive } from '../../shared/serve-bundle-coordination'
import {
  publishClaimedSnapshot,
  removeUnusedSnapshots,
  snapshotUsersDir
} from './claimed-snapshot-store'

/** Relocated supervisors can no longer derive the app root from __dirname. */
export const SERVE_SUPERVISOR_APP_ROOT_ENV = 'ORCA_SERVE_SUPERVISOR_APP_ROOT'

const PACKAGED_APP_ROOT_NAME = 'app.asar.unpacked'

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

function buildSnapshot(resources: string, root: string, id: string, pid: number): Promise<string> {
  return publishClaimedSnapshot(root, id, pid, async (directory) => {
    // Bare requires from out/ resolve through Resources/node_modules.
    for (const name of [PACKAGED_APP_ROOT_NAME, 'node_modules']) {
      if (await exists(join(resources, name))) {
        await copyTree(join(resources, name), join(directory, name))
      }
    }
  })
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
  rmSync(join(snapshotUsersDir(dirname(snapshotDir), basename(snapshotDir)), String(pid)), {
    force: true
  })
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
