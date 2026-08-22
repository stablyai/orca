import { runProcess } from '../shared/child-process/run-process'
import { lstat, readFile } from 'node:fs/promises'
import { buildWslExecArgs, quotePosixShell } from '../shared/wsl-login-shell-command'
import { removeHostTree } from './host-tree-removal'
import { toLinuxPath } from './wsl'
import type { ReadPath, StatPath } from './worktree-orphan-gitdir-proof'

export { toHostRemovalPath } from './host-tree-removal'

export type LocalWorktreeFilesystemOptions = {
  wslDistro?: string
}

type LocalWorktreePathAccess = {
  statPath: StatPath
  readPath: ReadPath
}

const WSL_FILE_OPERATION_TIMEOUT_MS = 30_000
/** The stat probe's explicit "missing path" branch. */
const WSL_MISSING_PATH_EXIT_CODE = 2

function shouldUseWslFilesystem(options: LocalWorktreeFilesystemOptions): boolean {
  return process.platform === 'win32' && !!options.wslDistro?.trim()
}

/**
 * Run a filesystem command inside the distro.
 *
 * Why no login shell: these are coreutils at standard paths plus shell builtins,
 * and need nothing from the user's PATH. A login shell would only add its rc/motd
 * output to the stdout these callers parse -- the banner problem -- so the fix is
 * to not start one rather than to fence what it prints.
 */
async function runWslCommand(distro: string, command: string): Promise<string> {
  const result = await runProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, ['sh', '-c', command]),
    timeoutMs: WSL_FILE_OPERATION_TIMEOUT_MS
  })
  if (result.timedOut) {
    throw new Error(`WSL filesystem command timed out after ${WSL_FILE_OPERATION_TIMEOUT_MS}ms`)
  }
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr.trim() || `wsl.exe exited ${result.code}`), {
      exitCode: result.code
    })
  }
  return result.stdout
}

function isWslMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { exitCode?: unknown }).exitCode === WSL_MISSING_PATH_EXIT_CODE
  )
}

export function toLocalWorktreeRuntimePath(
  targetPath: string,
  options: LocalWorktreeFilesystemOptions = {}
): string {
  return shouldUseWslFilesystem(options) ? toLinuxPath(targetPath) : targetPath
}

export function getLocalWorktreePathAccess(
  options: LocalWorktreeFilesystemOptions = {}
): LocalWorktreePathAccess {
  const distro = options.wslDistro?.trim()
  if (!shouldUseWslFilesystem(options) || !distro) {
    return {
      statPath: lstat,
      readPath: (path) => readFile(path, 'utf8')
    }
  }

  return {
    statPath: async (path) => {
      const target = quotePosixShell(toLinuxPath(path))
      const stdout = await runWslCommand(
        distro,
        [
          `target=${target}`,
          'if [ -L "$target" ]; then printf symlink; elif [ -f "$target" ]; then printf file; elif [ -d "$target" ]; then printf directory; else exit 2; fi'
        ].join('\n')
      ).catch((error) => {
        if (isWslMissingPathError(error)) {
          throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
        }
        throw error
      })
      return { type: stdout.trim() }
    },
    readPath: async (path) => {
      const target = quotePosixShell(toLinuxPath(path))
      const stdout = await runWslCommand(distro, `cat -- ${target}`)
      return stdout
    }
  }
}

export async function removeLocalWorktreePath(
  targetPath: string,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<void> {
  const distro = options.wslDistro?.trim()
  if (!shouldUseWslFilesystem(options) || !distro) {
    await removeHostTree(targetPath)
    return
  }

  // Why: WSL-owned worktree directories may be POSIX paths that Node on
  // Windows cannot delete safely. Run the deletion inside the selected distro.
  await runWslCommand(distro, `rm -rf -- ${quotePosixShell(toLinuxPath(targetPath))}`)
}
