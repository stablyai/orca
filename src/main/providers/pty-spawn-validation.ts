import { isAbsolute } from 'node:path'
import { existsSync, accessSync, constants as fsConstants } from 'node:fs'

export {
  formatLocalPtyEnvironmentDiag,
  validateWorkingDirectory,
  validateWorkingDirectoryAsync,
  WorkingDirectoryValidationAbortedError
} from './working-directory-validation'

const UNIX_SHELL_FALLBACKS = ['/bin/zsh', '/bin/bash', '/bin/sh'] as const

export function getShellValidationError(shellPath: string): string | null {
  if (!existsSync(shellPath)) {
    return (
      `Shell "${shellPath}" does not exist. ` +
      `Set a valid SHELL environment variable or install zsh/bash.`
    )
  }
  try {
    accessSync(shellPath, fsConstants.X_OK)
  } catch {
    return `Shell "${shellPath}" is not executable. Check file permissions.`
  }
  return null
}

/**
 * Resolves an absolute Unix shell before the native terminal forks. Bare commands and
 * relative paths stay untouched so execvp can resolve them against PATH or cwd.
 */
export function resolveUnixShellPath(shellPath: string): string {
  if (!isAbsolute(shellPath)) {
    return shellPath
  }
  const candidates = [
    shellPath,
    ...UNIX_SHELL_FALLBACKS.filter((candidate) => candidate !== shellPath)
  ]
  const resolved = candidates.find((candidate) => getShellValidationError(candidate) === null)
  if (resolved) {
    return resolved
  }
  throw new Error(`No executable Unix shell found (tried: ${candidates.join(', ')})`)
}
