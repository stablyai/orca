/**
 * On-disk layout of the generated shell-ready wrapper files, plus the marker the
 * wrappers emit — the shared contract between wrapper generation and shell launch.
 */
import { tmpdir } from 'node:os'
import { statSync } from 'node:fs'
import { ZSH_WRAPPER_DIR_MARKER_FILE } from '../shell-templates'

export const SHELL_READY_MARKER_ESCAPED = '\\033]777;orca-shell-ready\\007'

export function getShellReadyWrapperRoot(): string {
  // Why: bundled into the daemon fork (no electron), so read ORCA_USER_DATA_PATH rather than electron's userData; main and the fork both set it to the same path.
  const userDataPath = process.env.ORCA_USER_DATA_PATH ?? tmpdir()
  return `${userDataPath}/shell-ready`
}

export function getRequiredShellReadyWrapperPaths(root = getShellReadyWrapperRoot()): string[] {
  return [
    `${root}/zsh/.zshenv`,
    `${root}/zsh/.zprofile`,
    `${root}/zsh/.zshrc`,
    `${root}/zsh/.zlogin`,
    `${root}/zsh/${ZSH_WRAPPER_DIR_MARKER_FILE}`,
    `${root}/bash/rcfile`
  ]
}

/**
 * Every wrapper file exists and has content.
 *
 * Why non-empty and not just present: a partial write (full disk, killed mid
 * write) leaves a zero-byte .zshenv, and pointing ZDOTDIR at that directory
 * makes zsh skip the user's entire configuration silently.
 */
export function shellReadyWrappersExist(root = getShellReadyWrapperRoot()): boolean {
  return getRequiredShellReadyWrapperPaths(root).every((path) => {
    try {
      return statSync(path).size > 0
    } catch {
      return false
    }
  })
}
