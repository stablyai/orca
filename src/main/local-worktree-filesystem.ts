import { posix } from 'node:path'
import { runProcess } from '@orca/process-host'
import { lstat, stat, readFile, realpath } from 'node:fs/promises'
import { buildWslExecArgs } from '../shared/wsl-login-shell-command'
import { quotePosixShell } from '../shared/shell-argument-quoting'
import { removeHostTree } from './host-tree-removal'
import { toLinuxPath } from './wsl'
import { resolveWslInteropSpawnCwd } from './wsl-interop-spawn-directory'
import { describeWslProcessFailure } from './wsl/wsl-process-failure'
import type { WorktreeProofAccess } from './worktree-orphan-gitdir-proof'

export { toHostFilesystemPath, toHostRemovalPath } from './host-tree-removal'

export type LocalWorktreeFilesystemOptions = {
  wslDistro?: string
}

const WSL_FILE_OPERATION_TIMEOUT_MS = 30_000

function shouldUseWslFilesystem(options: LocalWorktreeFilesystemOptions): boolean {
  return process.platform === 'win32' && !!options.wslDistro?.trim()
}

// Coreutils need no login shell; rc/motd output would corrupt parsed stdout.
async function runWslCommand(distro: string, command: string): Promise<string> {
  const result = await runProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, ['sh', '-c', command]),
    // An inherited cwd may be the worktree currently being deleted (#16463).
    cwd: resolveWslInteropSpawnCwd(),
    timeoutMs: WSL_FILE_OPERATION_TIMEOUT_MS
  })
  if (result.timedOut) {
    throw new Error(`WSL filesystem command timed out after ${WSL_FILE_OPERATION_TIMEOUT_MS}ms`)
  }
  if (result.code !== 0) {
    throw Object.assign(new Error(describeWslProcessFailure(result)), {
      exitCode: result.code,
      stderr: result.stderr
    })
  }
  return result.stdout
}

// LC_ALL=C fixes strerror text; match only its tail because GNU and BusyBox use different verbs.
const WSL_MISSING_PATH_STDERR = /: (?:No such file or directory|Not a directory)\r?\n?$/

function isWslMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('exitCode' in error)) {
    return false
  }
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  return error.exitCode === 1 && WSL_MISSING_PATH_STDERR.test(stderr)
}

export function toLocalWorktreeRuntimePath(
  targetPath: string,
  options: LocalWorktreeFilesystemOptions = {}
): string {
  return shouldUseWslFilesystem(options) ? toLinuxPath(targetPath) : targetPath
}

export function getLocalWorktreePathAccess(
  options: LocalWorktreeFilesystemOptions = {}
): WorktreeProofAccess {
  const distro = options.wslDistro?.trim()
  if (!shouldUseWslFilesystem(options) || !distro) {
    return {
      statPath: lstat,
      layoutStatPath: stat,
      readPath: (path) => readFile(path, 'utf8'),
      realPath: realpath
    }
  }

  const inspect = (path: string, command: string) =>
    runWslCommand(distro, command).catch((error: unknown) => {
      if (isWslMissingPathError(error)) {
        throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
      }
      throw error
    })
  const statPath = async (path: string, follow: boolean) => {
    const target = quotePosixShell(toLinuxPath(path))
    // Shell file tests conflate permission failures with absence; stat preserves the reason.
    const stdout = await inspect(path, `LC_ALL=C stat ${follow ? '-L ' : ''}-c %F -- ${target}`)
    const kind = stdout.trim()
    return {
      type:
        kind === 'symbolic link'
          ? 'symlink'
          : kind === 'regular file' || kind === 'regular empty file'
            ? 'file'
            : kind === 'directory'
              ? 'directory'
              : 'other'
    }
  }
  return {
    statPath: (path) => statPath(path, false),
    layoutStatPath: (path) => statPath(path, true),
    realPath: async (path) => {
      const target = quotePosixShell(toLinuxPath(path))
      const stdout = await inspect(path, `LC_ALL=C realpath -e -- ${target}`)
      const resolved = stdout.replace(/\r?\n$/, '')
      if (!posix.isAbsolute(resolved) || /[\0\r\n]/.test(resolved)) {
        throw new Error('Invalid WSL canonical path')
      }
      return resolved
    },
    readPath: async (path) => {
      const target = quotePosixShell(toLinuxPath(path))
      const stdout = await inspect(path, `LC_ALL=C cat -- ${target}`)
      return stdout
    }
  }
}

export async function removeLocalWorktreePath(
  targetPath: string,
  options: LocalWorktreeFilesystemOptions = {},
  signal?: AbortSignal
): Promise<void> {
  const distro = options.wslDistro?.trim()
  if (!shouldUseWslFilesystem(options) || !distro) {
    await removeHostTree(targetPath, { signal })
    return
  }

  // Delete guest paths inside their distro; Windows Node cannot safely remove them.
  await runWslCommand(distro, `rm -rf -- ${quotePosixShell(toLinuxPath(targetPath))}`)
}
