import { execFile } from 'node:child_process'
import type { RmOptions } from 'node:fs'
import { lstat, readFile, rm } from 'node:fs/promises'
import { win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from '../shared/wsl-login-shell-command'
import { toLinuxPath } from './wsl'
import type { ReadPath, StatPath } from './worktree-orphan-gitdir-proof'

export type LocalWorktreeFilesystemOptions = {
  wslDistro?: string
}

type LocalWorktreePathAccess = {
  statPath: StatPath
  readPath: ReadPath
}

type ExecFileTextResult = {
  stdout: string
  stderr: string
}

const WSL_FILE_OPERATION_TIMEOUT_MS = 30_000
const WINDOWS_REMOVE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000]
const WINDOWS_RM_MAX_RETRIES = 8
const WINDOWS_RM_RETRY_DELAY_MS = 150

function shouldUseWslFilesystem(options: LocalWorktreeFilesystemOptions): boolean {
  return process.platform === 'win32' && !!options.wslDistro?.trim()
}

function execFileText(
  file: string,
  args: string[],
  options: { timeout: number }
): Promise<ExecFileTextResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: options.timeout },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? '')
        })
      }
    )
  })
}

function runWslLoginShellCommand(distro: string, command: string): Promise<ExecFileTextResult> {
  return execFileText(
    'wsl.exe',
    [
      '-d',
      distro,
      '--',
      'sh',
      '-lc',
      escapeWslShCommandForWindows(buildWslLoginShellCommand(command))
    ],
    { timeout: WSL_FILE_OPERATION_TIMEOUT_MS }
  )
}

function isWslMissingPathError(error: unknown): boolean {
  // Why: the WSL stat probe exits 2 for its explicit "missing path" branch;
  // normalize that shell-specific result so callers can handle it like fs.lstat.
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : ''
  return code === '2'
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
      const { stdout } = await runWslLoginShellCommand(
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
      const { stdout } = await runWslLoginShellCommand(distro, `cat -- ${target}`)
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
    await removeHostWorktreePath(targetPath)
    return
  }

  // Why: WSL-owned worktree directories may be POSIX paths that Node on
  // Windows cannot delete safely. Run the deletion inside the selected distro.
  await runWslLoginShellCommand(distro, `rm -rf -- ${quotePosixShell(toLinuxPath(targetPath))}`)
}

async function removeHostWorktreePath(targetPath: string): Promise<void> {
  const removalPath = toHostRemovalPath(targetPath)
  const retryDelays = process.platform === 'win32' ? WINDOWS_REMOVE_RETRY_DELAYS_MS : []
  const rmOptions = getHostRemovalOptions()
  let attempt = 0

  while (true) {
    try {
      await rm(removalPath, rmOptions)
      return
    } catch (error) {
      if (attempt >= retryDelays.length || !isTransientWindowsRemovalError(error)) {
        throw error
      }
      // Why: Git/Node recursive deletes on Windows can observe a just-emptied
      // directory before antivirus/indexers/handles release it.
      await delay(retryDelays[attempt])
      attempt += 1
    }
  }
}

function getHostRemovalOptions(): RmOptions {
  const base = { recursive: true, force: true }
  if (process.platform !== 'win32') {
    return base
  }
  return {
    ...base,
    // Why: large Windows dependency trees commonly surface transient
    // ENOTEMPTY/EPERM while Node walks and removes nested directories.
    maxRetries: WINDOWS_RM_MAX_RETRIES,
    retryDelay: WINDOWS_RM_RETRY_DELAY_MS
  }
}

function isTransientWindowsRemovalError(error: unknown): boolean {
  if (process.platform !== 'win32' || typeof error !== 'object' || error === null) {
    return false
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code)) {
    return true
  }
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  return /directory not empty|resource busy|operation not permitted/i.test(message)
}

export function toHostRemovalPath(targetPath: string): string {
  // Why: Git for Windows can fail long recursive deletes even after Orca has
  // proven the worktree target; Node's host deletion should use Win32 long paths.
  return process.platform === 'win32' ? win32.toNamespacedPath(targetPath) : targetPath
}
