import type { ResolvedCommand } from './wsl-command-resolution'
import { readWslExeFailure } from '../../wsl/wsl-exe-failure'

/** The wsl.exe host failure behind a failed git call that ran through WSL; see readWslExeFailure. */
export function readWslHostFailureDiagnostic(
  error: unknown,
  command: ResolvedCommand
): string | null {
  if (!command.wsl || !error || typeof error !== 'object') {
    return null
  }
  return readWslExeFailure(error)
}

/**
 * Move a wsl.exe host failure into the error's message, which is what `git.exec` spans record ahead
 * of the stack. Left untouched when the failure came from git itself.
 */
export function annotateWslHostFailure(error: unknown, command: ResolvedCommand): unknown {
  const diagnostic = readWslHostFailureDiagnostic(error, command)
  if (diagnostic === null || !(error instanceof Error) || !command.wsl) {
    return error
  }
  const distro = command.wsl.distro
  error.message = `wsl.exe host failure (distro "${distro}"): ${diagnostic}\n${error.message}`
  return Object.assign(error, { wslHostFailure: true, wslDistro: distro })
}
