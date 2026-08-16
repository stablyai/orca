/**
 * On-disk layout of the generated shell-ready wrapper files, plus the marker the
 * wrappers emit — the shared contract between wrapper generation and shell launch.
 */
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

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
    `${root}/bash/rcfile`
  ]
}

export function shellReadyWrappersExist(root = getShellReadyWrapperRoot()): boolean {
  return getRequiredShellReadyWrapperPaths(root).every((path) => existsSync(path))
}
