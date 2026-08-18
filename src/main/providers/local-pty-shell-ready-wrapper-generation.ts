/**
 * Generates the zsh ZDOTDIR tree and bash rcfile Orca launches shells with.
 *
 * Why: the wrappers emit an OSC 777 marker after startup files finish, which the
 * readiness scanner watches for before a startup command is written.
 */
import {
  buildZshStartupWrapperFiles,
  type ZshStartupWrapperFiles,
  type ZshStartupWrapperSpec
} from '../zsh-startup-wrapper-builder'
import { writeShellWrapperFiles } from '../shell-wrapper-file-writer'
import { ZSH_WRAPPER_DIR_MARKER_CONTENT, ZSH_WRAPPER_DIR_MARKER_FILE } from '../shell-templates'
import { getBashShellReadyRcfileContent } from './local-pty-shell-ready-bash-rcfile'
import {
  getShellReadyWrapperRoot,
  shellReadyWrappersExist,
  SHELL_READY_MARKER_ESCAPED
} from './local-pty-shell-ready-wrapper-root'

let didEnsureShellReadyWrappers = false

function getLocalZshWrapperSpec(zshDir: string): ZshStartupWrapperSpec {
  return {
    headerLabel: 'Orca zsh shell-ready wrapper',
    zshDir,
    zshenvStrategy: 'discover-user-zdotdir',
    readyMarkerEscaped: SHELL_READY_MARKER_ESCAPED,
    osc133CommandMarkers: true,
    skipUserZshrcWhenHomeIsWrapperDir: true,
    overlayRestoreComment:
      "# Why: ~/.zshrc can export the user's default OpenCode config after spawn.",
    restores: {
      agentTeamsPath: true,
      remoteCliBinDir: false,
      codexHome: true,
      codexLaunchPreflight: true
    }
  }
}

export function getZshShellReadyWrapperFiles(): ZshStartupWrapperFiles {
  return buildZshStartupWrapperFiles(getLocalZshWrapperSpec(`${getShellReadyWrapperRoot()}/zsh`))
}

/** True when every wrapper file is present and non-empty afterwards. */
export function ensureShellReadyWrappersAt(root = getShellReadyWrapperRoot()): boolean {
  if (didEnsureShellReadyWrappers && shellReadyWrappersExist(root)) {
    return true
  }
  didEnsureShellReadyWrappers = true

  const zshDir = `${root}/zsh`
  const zsh = buildZshStartupWrapperFiles(getLocalZshWrapperSpec(zshDir))

  const written = writeShellWrapperFiles(
    [
      [`${zshDir}/.zshenv`, zsh.zshenv],
      [`${zshDir}/.zprofile`, zsh.zprofile],
      [`${zshDir}/.zshrc`, zsh.zshrc],
      [`${zshDir}/.zlogin`, zsh.zlogin],
      [`${zshDir}/${ZSH_WRAPPER_DIR_MARKER_FILE}`, ZSH_WRAPPER_DIR_MARKER_CONTENT],
      [`${root}/bash/rcfile`, getBashShellReadyRcfileContent()]
    ],
    '[shell-ready]'
  )
  if (!written || !shellReadyWrappersExist(root)) {
    // Why reset: the next launch retries instead of trusting a half-written tree.
    didEnsureShellReadyWrappers = false
    return false
  }
  return true
}

export function ensureShellReadyWrappers(): boolean {
  if (process.platform === 'win32') {
    return false
  }
  return ensureShellReadyWrappersAt()
}
