import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import type { SpawnOptions } from 'node:child_process'

export const FD_CLOSING_EXEC_ARGS = ['--exec-without-inherited-fds', '--'] as const

// libuv's search path when the child's environment has no PATH.
const DEFAULT_SEARCH_PATH = '/usr/bin:/bin'

export type FdClosingLaunch = { file: string; args: string[] }

/**
 * Linux: run `file` through the fd-closing helper so the child keeps only stdio and the IPC
 * channel. Null off Linux, or when `file` doesn't resolve to a runnable file, so the direct spawn
 * still fails with ENOENT/EACCES instead of the helper's exit 127.
 */
export function fdClosingLaunch(
  helper: string | undefined,
  file: string,
  args: readonly string[],
  options: Pick<SpawnOptions, 'cwd' | 'env' | 'stdio'>
): FdClosingLaunch | null {
  if (process.platform !== 'linux' || !helper) {
    return null
  }
  const stdio = options.stdio
  if (Array.isArray(stdio) && stdio.slice(3).some((slot) => slot !== 'ipc' && slot != null)) {
    throw new Error('fd-closing launches keep only stdio and IPC; extra stdio slots would close')
  }
  const runnable = resolveRunnable(file, String(options.cwd ?? process.cwd()), options.env)
  return runnable ? { file: helper, args: [...FD_CLOSING_EXEC_ARGS, runnable, ...args] } : null
}

// execvp's lookup: a name with a slash is a path; otherwise each PATH entry, empty ones from cwd.
function resolveRunnable(
  file: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined
): string | null {
  if (file.includes('/')) {
    const path = resolve(cwd, file)
    return isRunnable(path) ? path : null
  }
  const searchPath = (env ?? process.env).PATH ?? DEFAULT_SEARCH_PATH
  for (const directory of searchPath.split(delimiter)) {
    const path = resolve(cwd, directory, file)
    if (isRunnable(path)) {
      return path
    }
  }
  return null
}

function isRunnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
