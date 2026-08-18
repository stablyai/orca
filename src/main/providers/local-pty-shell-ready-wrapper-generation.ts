/**
 * Generates the zsh ZDOTDIR tree and bash rcfile Orca launches shells with.
 *
 * Why: the wrappers emit an OSC 777 marker after startup files finish, which the
 * readiness scanner watches for before a startup command is written.
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import {
  buildZshStartupWrapperFiles,
  type ZshStartupWrapperSpec
} from '../zsh-startup-wrapper-builder'
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
    interactiveRestoreComment:
      "# Why: ~/.zshrc can export the user's default OpenCode config after spawn.",
    loginRestoreComment:
      '# Why: .zlogin is the final login startup file before the prompt is shown.',
    restores: {
      agentTeamsPath: true,
      remoteCliBinDir: false,
      codexHome: true,
      codexLaunchPreflight: true
    },
    readyMarkerOrder: 'before-zdotdir-restore',
    legacyFormatting: {
      unindentedMimocodeRestore: true,
      codexHomeRestoreComment:
        "# Why: Codex must keep using Orca's runtime CODEX_HOME after rc files."
    }
  }
}

export function getZshShellReadyRcfileContent(): string {
  return buildZshStartupWrapperFiles(getLocalZshWrapperSpec(`${getShellReadyWrapperRoot()}/zsh`))
    .zshrc
}

export function ensureShellReadyWrappersAt(root = getShellReadyWrapperRoot()): void {
  if (didEnsureShellReadyWrappers && shellReadyWrappersExist(root)) {
    return
  }
  didEnsureShellReadyWrappers = true

  const zshDir = `${root}/zsh`
  const bashDir = `${root}/bash`

  const zsh = buildZshStartupWrapperFiles(getLocalZshWrapperSpec(zshDir))
  const bashRc = getBashShellReadyRcfileContent()

  const files = [
    [`${zshDir}/.zshenv`, zsh.zshenv],
    [`${zshDir}/.zprofile`, zsh.zprofile],
    [`${zshDir}/.zshrc`, zsh.zshrc],
    [`${zshDir}/.zlogin`, zsh.zlogin],
    [`${bashDir}/rcfile`, bashRc]
  ] as const

  try {
    for (const [path, content] of files) {
      const dir = path.slice(0, path.lastIndexOf('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, content, 'utf8')
      chmodSync(path, 0o644)
    }
  } catch (error) {
    // Why: degrade gracefully — a failed wrapper (read-only FS, perms, disk) just means no ready marker, PTY stays usable.
    const errorMessage =
      error instanceof Error
        ? `${error.message} (${(error as NodeJS.ErrnoException).code || 'unknown'})`
        : String(error)
    console.error(`[shell-ready] Failed to create wrapper files in ${root}: ${errorMessage}`)
    console.error('[shell-ready] Shell will launch without wrapper (no shell-ready marker)')
    // Reset the flag so next attempt will try again
    didEnsureShellReadyWrappers = false
  }
}

export function ensureShellReadyWrappers(): void {
  if (process.platform === 'win32') {
    return
  }
  ensureShellReadyWrappersAt()
}
