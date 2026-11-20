import { accessSync, constants, statSync } from 'node:fs'
import { delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSystemErrorName } from 'node:util'
import type { ChildProcess, SpawnOptions, StdioOptions } from 'node:child_process'

export const FD_CLOSING_EXEC_ARGS = ['--exec-without-inherited-fds', '--'] as const
// The helper writes a failed exec's errno to this fd; a successful exec closes it.
const EXEC_STATUS_FD_ENV = 'ORCA_EXEC_STATUS_FD'

// libuv's search path when the child's environment has no PATH.
const DEFAULT_SEARCH_PATH = '/usr/bin:/bin'

type StdioSlot = Exclude<StdioOptions, string>[number]

let installedHelper: string | undefined
let missingHelperLogged = false

/** Main installs the Linux helper that execs a command keeping only stdio and NODE_CHANNEL_FD. */
export function setFdClosingExec(helper: string | undefined): void {
  installedHelper = helper
}

export type FdClosingLaunch = {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  stdio: StdioSlot[]
  /** What the caller asked to run, for the error a failed exec reports. */
  target: { file: string; args: readonly string[]; statusFd: number }
}

/**
 * Linux: run `file` through the installed fd-closing helper so the child keeps only stdio and the
 * IPC channel; pass the spawned child to `watchFdClosingExec`. Null off Linux, without a helper,
 * or when `file` isn't on PATH, so a direct spawn reports that itself.
 */
export function fdClosingLaunch(
  file: string,
  args: readonly string[],
  options: Pick<SpawnOptions, 'cwd' | 'env' | 'stdio'>
): FdClosingLaunch | null {
  const helper = installedHelper
  if (process.platform !== 'linux' || !helper) {
    return null
  }
  if (!isExecutableFile(helper)) {
    if (!missingHelperLogged) {
      missingHelperLogged = true
      console.warn(`[process-host] ${helper} is unavailable; children inherit our descriptors`)
    }
    return null
  }
  const stdio = normalizeStdio(options.stdio)
  if (stdio.slice(3).some((slot) => slot !== 'ipc' && slot != null)) {
    throw new Error('fd-closing launches keep only stdio and IPC; extra stdio slots would close')
  }
  if (!onSearchPath(file, options)) {
    return null
  }
  const statusFd = stdio.length
  // The helper starts after the child's chdir and execvp's the same name, so argv0 is unchanged.
  return {
    file: helper,
    args: [...FD_CLOSING_EXEC_ARGS, file, ...args],
    env: { ...(options.env ?? process.env), [EXEC_STATUS_FD_ENV]: String(statusFd) },
    stdio: [...stdio, 'pipe'],
    target: { file, args, statusFd }
  }
}

/**
 * Holds 'spawn', 'exit' and 'close' until the helper's exec settles, then replays them in order.
 * A failed exec instead emits what a direct spawn would: 'error' (code, errno, syscall, path,
 * spawnargs), then 'close' with the negative errno, and no 'spawn' or 'exit'.
 */
export function watchFdClosingExec<T extends ChildProcess>(child: T, launch: FdClosingLaunch): T {
  const status = child.stdio[launch.target.statusFd]
  if (!status) {
    return child
  }
  const emit = child.emit.bind(child)
  const held: [string | symbol, unknown[]][] = []
  let settled = false
  let failure: NodeJS.ErrnoException | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards every event unchanged except lifecycle events held until the exec status settles.
  child.emit = ((event: string | symbol, ...rest: unknown[]): boolean => {
    const lifecycle = event === 'spawn' || event === 'exit' || event === 'close'
    if (failure && lifecycle) {
      return event === 'close' ? emit('close', failure.errno, null) : true
    }
    if (!settled && lifecycle) {
      held.push([event, rest])
      return true
    }
    return emit(event, ...rest)
  }) as T['emit']
  let report = ''
  status.on('data', (chunk: Buffer | string) => {
    report += chunk.toString()
  })
  status.on('error', () => {})
  status.once('close', () => {
    settled = true
    const errno = Number.parseInt(report, 10)
    if (Number.isInteger(errno) && errno > 0) {
      failure = execError(errno, launch.target)
      emit('error', failure)
      if (held.some(([event]) => event === 'close')) {
        emit('close', failure.errno, null)
      }
      return
    }
    for (const [event, rest] of held) {
      emit(event, ...rest)
    }
  })
  return child
}

function execError(errno: number, target: FdClosingLaunch['target']): NodeJS.ErrnoException {
  const code = getSystemErrorName(-errno)
  return Object.assign(new Error(`spawn ${target.file} ${code}`), {
    errno: -errno,
    code,
    syscall: `spawn ${target.file}`,
    path: target.file,
    spawnargs: [...target.args]
  })
}

// Node's defaults: a string covers fds 0-2, and missing fds 0-2 are pipes.
function normalizeStdio(stdio: SpawnOptions['stdio']): StdioSlot[] {
  if (stdio === undefined || typeof stdio === 'string') {
    const slot = stdio ?? 'pipe'
    return [slot, slot, slot]
  }
  const slots: StdioSlot[] = [...stdio]
  while (slots.length < 3) {
    slots.push(undefined)
  }
  return slots
}

// execvp's lookup, unnormalized so symlinks and `..` resolve as the kernel does.
function onSearchPath(file: string, options: Pick<SpawnOptions, 'cwd' | 'env'>): boolean {
  const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd
  const inCwd = (path: string): string =>
    path.startsWith('/') || cwd === undefined ? path : `${cwd}/${path}`
  if (file.includes('/')) {
    return isExecutableFile(inCwd(file))
  }
  const searchPath = (options.env ?? process.env).PATH ?? DEFAULT_SEARCH_PATH
  return searchPath
    .split(delimiter)
    .some((directory) => isExecutableFile(inCwd(directory === '' ? file : `${directory}/${file}`)))
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}
