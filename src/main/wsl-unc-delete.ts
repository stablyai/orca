import { runProcess } from '@orca/process-host'
import { buildWslExecArgs } from '../shared/wsl-login-shell-command'
import { parseWslPath } from './wsl'
import { wslExeFailure, wslExeProcessSpec } from './wsl-exe-process'
import {
  containedDeleteCommand,
  rejectionFromWslDeleteStderr,
  type WslDeleteRejection
} from './wsl-contained-delete'

export class WslDeleteValidationError extends Error {
  constructor(
    readonly reason: WslDeleteRejection,
    message: string
  ) {
    super(message)
    this.name = 'WslDeleteValidationError'
  }
}

/**
 * Delete a file/directory that lives on a WSL distro's Linux filesystem,
 * addressed from Windows via a \\wsl.localhost\<distro>\... (or legacy
 * \\wsl$\...) UNC path.
 *
 * Why: Electron's shell.trashItem() cannot move a WSL UNC item to a Recycle
 * Bin — the WSL virtual volume has none — so it throws and the delete fails
 * (issue #6415). For these paths we run `rm` inside the distro via wsl.exe,
 * which performs a true delete on the Linux fs and honors Linux permissions.
 *
 * Returns false when the path is not a WSL UNC path, so callers can fall back
 * to the normal local-trash behavior (we must never hard-delete a normal local
 * file that currently goes to the Recycle Bin).
 */
export async function tryDeleteWslUncPath(
  targetPath: string,
  options: { recursive?: boolean; approvedRoots?: readonly string[] } = {}
): Promise<boolean> {
  const info = parseWslPath(targetPath)
  if (!info) {
    return false
  }

  let command: string[]
  if (options.approvedRoots) {
    const contained = containedDeleteCommand(
      info,
      options.approvedRoots,
      parseWslPath,
      options.recursive === true
    )
    if (!contained) {
      throw new WslDeleteValidationError(
        'path-outside-known-roots',
        'Refusing WSL delete outside approved roots'
      )
    }
    command = contained
  } else {
    const flags = options.recursive ? '-rf' : '-f'
    command = ['rm', flags, '--', info.linuxPath]
  }
  await runWslDelete(info.distro, command)
  return true
}

async function runWslDelete(distro: string, command: string[]): Promise<void> {
  // Why: a generous bound so deleting a large directory tree on the WSL fs
  // doesn't abort mid-delete, while still capping a wedged wsl.exe.
  // The explicit cwd matters here (#16463): this deletes worktrees, so an
  // inherited cwd is exactly the directory about to go.
  const result = await runProcess(wslExeProcessSpec(buildWslExecArgs(distro, command), 30000))
  const failure = wslExeFailure(result)
  if (failure) {
    throw wslDeleteError(failure, result.stderr)
  }
}

function wslDeleteError(failure: string, stderr: string): Error {
  const detail = stderr.trim()
  const rejection = rejectionFromWslDeleteStderr(stderr)
  if (rejection) {
    return new WslDeleteValidationError(rejection, `Refusing WSL delete: ${detail}`)
  }
  return new Error(`Failed to delete WSL path: ${detail || failure}`)
}
