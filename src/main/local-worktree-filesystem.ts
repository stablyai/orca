import { execFile } from 'node:child_process'
import { lstat, readFile, rm } from 'node:fs/promises'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from '../shared/wsl-login-shell-command'
import { toLinuxPath } from './wsl'
import type { ReadPath, StatPath } from './worktree-orphan-gitdir-proof'

type LocalWorktreeFilesystemOptions = {
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
      )
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
    await rm(targetPath, { recursive: true, force: true })
    return
  }

  // Why: WSL-owned worktree directories may be POSIX paths that Node on
  // Windows cannot delete safely. Run the deletion inside the selected distro.
  await runWslLoginShellCommand(distro, `rm -rf -- ${quotePosixShell(toLinuxPath(targetPath))}`)
}
