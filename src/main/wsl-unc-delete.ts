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

/** WSL has no Recycle Bin: delete inside the distro; return false for other paths so normal trash behavior survives. */
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
  // Allow large-tree deletion time while bounding a wedged wsl.exe; the process spec supplies a stable host cwd.
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
