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
// Enough for the ELF header, program headers and loader path of ordinary executables.
const HEAD_MAX_BYTES = 4096

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

// Wraps only what it can predict the kernel will run: a `#!` script whose interpreter would run,
// or an ELF for this machine whose loader exists. Anything else spawns directly, so its exec
// failure still reaches the caller. A relative interpreter resolves from the child's cwd.
function isRunnable(path: string, inCwd: (path: string) => string, depth = 0): boolean {
  if (depth > INTERPRETER_MAX_DEPTH || !isExecutableFile(path)) {
    return false
  }
  const head = readHead(path)
  if (!head) {
    return false
  }
  if (head.subarray(0, 2).toString('latin1') === '#!') {
    const interpreter = shebangInterpreter(head)
    return interpreter !== null && isRunnable(inCwd(interpreter), inCwd, depth + 1)
  }
  return isLoadableElf(head)
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// null: unreadable (e.g. execute-only), so exec's own checks can't be predicted.
function readHead(path: string): Buffer | null {
  const head = Buffer.alloc(HEAD_MAX_BYTES)
  try {
    const fd = openSync(path, 'r')
    try {
      return head.subarray(0, readSync(fd, head, 0, HEAD_MAX_BYTES, 0))
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

// The kernel's parse: skip spaces and tabs, end at space, tab, newline or NUL; a CR stays.
function shebangInterpreter(head: Buffer): string | null {
  const line = head.subarray(2, SHEBANG_MAX_BYTES).toString('utf8')
  return /^[ \t]*([^ \t\n\0]+)/.exec(line)?.[1] ?? null
}

const ELF_MACHINE: Partial<Record<NodeJS.Architecture, number>> = {
  x64: 62,
  arm64: 183,
  ia32: 3,
  arm: 40
}
const PT_INTERP = 3

// A little-endian ELF for this architecture whose PT_INTERP loader (if any) is present.
function isLoadableElf(head: Buffer): boolean {
  if (head.length < 64 || head.readUInt32BE(0) !== 0x7f454c46 || head[5] !== 1) {
    return false
  }
  if (head.readUInt16LE(18) !== ELF_MACHINE[process.arch]) {
    return false
  }
  const wide = head[4] === 2
  const phoff = Number(wide ? head.readBigUInt64LE(32) : head.readUInt32LE(28))
  const phentsize = head.readUInt16LE(wide ? 54 : 42)
  const phnum = head.readUInt16LE(wide ? 56 : 44)
  for (let index = 0; index < phnum; index++) {
    const entry = phoff + index * phentsize
    if (entry + phentsize > head.length) {
      return false
    }
    if (head.readUInt32LE(entry) !== PT_INTERP) {
      continue
    }
    const offset = Number(wide ? head.readBigUInt64LE(entry + 8) : head.readUInt32LE(entry + 4))
    const size = Number(wide ? head.readBigUInt64LE(entry + 32) : head.readUInt32LE(entry + 16))
    if (size < 2 || offset + size > head.length) {
      return false
    }
    return isExecutableFile(head.subarray(offset, offset + size - 1).toString('utf8'))
  }
  return true
}
