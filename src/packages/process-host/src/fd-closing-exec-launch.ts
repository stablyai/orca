import { accessSync, closeSync, constants, openSync, readSync, statSync } from 'node:fs'
import { delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SpawnOptions } from 'node:child_process'

export const FD_CLOSING_EXEC_ARGS = ['--exec-without-inherited-fds', '--'] as const

// libuv's search path when the child's environment has no PATH.
const DEFAULT_SEARCH_PATH = '/usr/bin:/bin'
// Linux reads at most this much of a `#!` line, and follows at most this many interpreters.
const SHEBANG_MAX_BYTES = 256
const INTERPRETER_MAX_DEPTH = 4

let installedHelper: string | undefined
let missingHelperLogged = false

/** Main installs the Linux helper that execs a command keeping only stdio and NODE_CHANNEL_FD. */
export function setFdClosingExec(helper: string | undefined): void {
  installedHelper = helper
}

export type FdClosingLaunch = { file: string; args: string[] }

/**
 * Linux: run `file` through the installed fd-closing helper so the child keeps only stdio and the
 * IPC channel. Null off Linux, without a helper, or when `file` wouldn't exec, so the direct spawn
 * still fails with ENOENT/EACCES instead of the helper's exit 127.
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
  const stdio = options.stdio
  if (Array.isArray(stdio) && stdio.slice(3).some((slot) => slot !== 'ipc' && slot != null)) {
    throw new Error('fd-closing launches keep only stdio and IPC; extra stdio slots would close')
  }
  // The helper starts after the child's chdir and execvp's the same name, so argv0 is unchanged.
  return wouldExec(file, options)
    ? { file: helper, args: [...FD_CLOSING_EXEC_ARGS, file, ...args] }
    : null
}

// execvp's lookup, unnormalized so symlinks and `..` resolve as the kernel does.
function wouldExec(file: string, options: Pick<SpawnOptions, 'cwd' | 'env'>): boolean {
  const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd
  const inCwd = (path: string): string =>
    path.startsWith('/') || cwd === undefined ? path : `${cwd}/${path}`
  if (file.includes('/')) {
    return isRunnable(inCwd(file), inCwd)
  }
  const searchPath = (options.env ?? process.env).PATH ?? DEFAULT_SEARCH_PATH
  return searchPath
    .split(delimiter)
    .some((directory) => isRunnable(inCwd(directory === '' ? file : `${directory}/${file}`), inCwd))
}

// A script runs only if its `#!` interpreter does; exec otherwise fails with ENOENT or EACCES.
// A relative interpreter resolves from the child's cwd, as the kernel resolves it.
function isRunnable(path: string, inCwd: (path: string) => string, depth = 0): boolean {
  if (depth > INTERPRETER_MAX_DEPTH || !isExecutableFile(path)) {
    return false
  }
  const interpreter = shebangInterpreter(path)
  if (interpreter === undefined) {
    return false
  }
  return interpreter === null || isRunnable(inCwd(interpreter), inCwd, depth + 1)
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// undefined: unreadable, so exec's own check can't be predicted and the launch isn't wrapped.
function shebangInterpreter(path: string): string | null | undefined {
  const head = Buffer.alloc(SHEBANG_MAX_BYTES)
  let length: number
  try {
    const fd = openSync(path, 'r')
    try {
      length = readSync(fd, head, 0, SHEBANG_MAX_BYTES, 0)
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  const text = head.subarray(0, length).toString('utf8')
  // The kernel's parse: skip spaces and tabs, end at space, tab, newline or NUL; a CR stays.
  return text.startsWith('#!') ? (/^[ \t]*([^ \t\n\0]+)/.exec(text.slice(2))?.[1] ?? null) : null
}
