import { accessSync, constants, statSync } from 'node:fs'
import { getSystemErrorName } from 'node:util'
import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from 'node:child_process'

export const FD_CLOSING_EXEC_ARGS = ['--exec-without-inherited-fds', '--'] as const
// The helper writes a failed exec's errno to this fd; a successful exec closes it.
const EXEC_STATUS_FD_ENV = 'ORCA_EXEC_STATUS_FD'

type StdioSlot = Exclude<StdioOptions, string>[number]

let installedHelper: string | undefined
// Checked once, on the first launch that opts in, so later launches do no filesystem work.
let helperUsable: boolean | undefined

/** Main installs the Linux helper that execs a command keeping only stdio and NODE_CHANNEL_FD. */
export function setFdClosingExec(helper: string | undefined): void {
  installedHelper = helper
  helperUsable = undefined
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
 * IPC channel; pass the spawned child to `watchFdClosingExec`, which reports a failed exec as the
 * spawn error. Null off Linux or without a usable helper.
 */
export function fdClosingLaunch(
  file: string,
  args: readonly string[],
  options: Pick<SpawnOptions, 'env' | 'stdio'>
): FdClosingLaunch | null {
  const helper = installedHelper
  if (process.platform !== 'linux' || !helper) {
    return null
  }
  if (helperUsable === undefined) {
    helperUsable = isExecutableFile(helper)
    if (!helperUsable) {
      console.warn(`[process-host] ${helper} is unavailable; children inherit our descriptors`)
    }
  }
  if (!helperUsable) {
    return null
  }
  const stdio = normalizeStdio(options.stdio)
  if (stdio.slice(3).some((slot) => slot !== 'ipc' && slot != null)) {
    throw new Error('fd-closing launches keep only stdio and IPC; extra stdio slots would close')
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
 * Holds 'spawn', 'exit' and 'close' until the helper's exec settles, then replays them in order,
 * one per macrotask as Node spaces them, so a listener added after awaiting one still sees the
 * next. A failed exec instead emits what a direct spawn would: 'error' (code, errno, syscall,
 * path, spawnargs), then 'close' with the negative errno, and no 'spawn' or 'exit'.
 */
export function watchFdClosingExec<T extends ChildProcess>(child: T, launch: FdClosingLaunch): T {
  const emitRaw = child.emit.bind(child)
  const emit = (event: string | symbol, ...rest: unknown[]): boolean =>
    event === 'error'
      ? emitRaw(event, retargetSpawnError(rest[0], launch), ...rest.slice(1))
      : emitRaw(event, ...rest)
  const status = child.stdio[launch.target.statusFd]
  if (!status) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards every event unchanged except naming the caller's program in a spawn error.
    child.emit = emit as T['emit']
    return child
  }
  const pending: [string | symbol, unknown[]][] = []
  let gate: 'held' | 'open' | 'failed' = 'held'
  let failure: NodeJS.ErrnoException | null = null
  let flushing = false
  const flush = (): void => {
    const next = pending.shift()
    if (next) {
      emit(next[0], ...next[1])
    }
    if (pending.length > 0) {
      setImmediate(flush)
    } else {
      flushing = false
    }
  }
  const startFlush = (): void => {
    if (!flushing && pending.length > 0) {
      flushing = true
      flush()
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards every event unchanged except lifecycle events, which are held until the exec status settles.
  child.emit = ((event: string | symbol, ...rest: unknown[]): boolean => {
    if (event !== 'spawn' && event !== 'exit' && event !== 'close') {
      return emit(event, ...rest)
    }
    if (gate === 'failed') {
      if (event === 'close' && failure) {
        pending.push(['close', [failure.errno, null]])
        startFlush()
      }
      return true
    }
    if (gate === 'held' || flushing) {
      pending.push([event, rest])
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
    const errno = Number.parseInt(report, 10)
    if (Number.isInteger(errno) && errno > 0) {
      gate = 'failed'
      failure = execError(errno, launch.target)
      const closed = pending.some(([event]) => event === 'close')
      pending.length = 0
      pending.push(['error', [failure]])
      if (closed) {
        pending.push(['close', [failure.errno, null]])
      }
    } else {
      gate = 'open'
    }
    startFlush()
  })
  return child
}

/** Linux: `spawn` with the child kept off this process's other fds (see `fdClosingLaunch`). */
export function spawnWithoutInheritedFds(
  file: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcess {
  const launch = options.shell ? null : fdClosingLaunch(file, args, options)
  if (!launch) {
    return spawn(file, [...args], options)
  }
  let child: ChildProcess
  try {
    child = spawn(launch.file, launch.args, { ...options, env: launch.env, stdio: launch.stdio })
  } catch (error) {
    throw retargetSpawnError(error, launch)
  }
  return watchFdClosingExec(child, launch)
}

/** A failure before the helper runs (e.g. a missing cwd) names the caller's program, as a direct spawn would. */
export function retargetSpawnError(error: unknown, launch: FdClosingLaunch): unknown {
  if (!(error instanceof Error) || !('path' in error) || error.path !== launch.file) {
    return error
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN'
  return Object.assign(error, {
    message: `spawn ${launch.target.file} ${code}`,
    syscall: `spawn ${launch.target.file}`,
    path: launch.target.file,
    spawnargs: [...launch.target.args]
  })
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

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}
