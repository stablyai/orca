/**
 * The single source of the zsh startup wrapper files (.zshenv/.zprofile/.zshrc/
 * .zlogin) Orca writes for every transport: local PTY, daemon/SSH, and relay.
 *
 * Why: the three generators were copies that drifted apart, so a fix landed in
 * one transport and silently missed the other two. Everything they genuinely
 * disagree on is a field on ZshStartupWrapperSpec, so the disagreements are
 * visible in one place instead of spread across three template literals.
 */
import { getPosixOmpShellWrapper } from './pty/omp-shell-wrapper'
import { getPosixCodexShellLaunchPreflight } from './pty/codex-shell-launch-preflight'
import {
  getZshEnvTemplate,
  getZshFinalZdotdirRestoreBlock,
  getZshOverlayEnvTemplate,
  getZshShellReadyMarkerRegistrationBlock,
  getZshStartupFileSourceBlock,
  ZSH_HISTFILE_RESTORE_BLOCK
} from './shell-templates'

/** Runtime values the wrapper re-exports after the user's own startup files ran. */
export type ZshWrapperRestoreSpec = {
  /** Orca's agent-teams shim dir back onto PATH. */
  agentTeamsPath: boolean
  /** Remote CLI bin dir onto PATH — relay hosts only. */
  remoteCliBinDir: boolean
  /** Orca's runtime CODEX_HOME. */
  codexHome: boolean
  /** The `codex()` wrapper that runs Orca's launch preflight. */
  codexLaunchPreflight: boolean
}

/**
 * Pre-existing cosmetic drift in the .zshrc restore block. Carried as explicit
 * fields so unifying the generators stays byte-identical; normalizing these
 * away is a follow-up, not part of the unification.
 */
export type ZshWrapperLegacyFormatting = {
  /** Local .zshrc lost the two-space indent on the MIMOCODE_HOME restore. */
  unindentedMimocodeRestore?: boolean
  /** Only local .zshrc carries a comment above the CODEX_HOME restore. */
  codexHomeRestoreComment?: string
}

export type ZshStartupWrapperSpec = {
  /** First line of every generated file, e.g. `# Orca zsh shell-ready wrapper`. */
  headerLabel: string
  /** Wrapper ZDOTDIR baked into .zshenv as the fallback literal. */
  zshDir: string
  /**
   * How .zshenv finds the user's real ZDOTDIR. `discover-user-zdotdir` sources
   * the user .zshenv and reads what it exported; `overlay-user-zdotdir` trusts
   * the inherited ZDOTDIR and republishes it as ORCA_USER_ZDOTDIR.
   */
  zshenvStrategy: 'discover-user-zdotdir' | 'overlay-user-zdotdir'
  /** zsh expression the wrapper resolves the user's startup-file dir from. */
  homeExpression?: string
  readyMarkerEscaped: string
  /** OSC 133 command-lifecycle hooks in .zshrc. */
  osc133CommandMarkers: boolean
  /** Skip the user .zshrc when its dir is already the wrapper ZDOTDIR. */
  skipUserZshrcWhenHomeIsWrapperDir: boolean
  /** Comment heading the non-login restore block in .zshrc. */
  interactiveRestoreComment: string
  /** Comment heading the restore block in .zlogin. */
  loginRestoreComment: string
  restores: ZshWrapperRestoreSpec
  /** Where the ready-marker widget lands relative to the final ZDOTDIR restore. */
  readyMarkerOrder: 'before-zdotdir-restore' | 'after-zdotdir-restore'
  legacyFormatting?: ZshWrapperLegacyFormatting
}

export type ZshStartupWrapperFiles = {
  zshenv: string
  zprofile: string
  zshrc: string
  zlogin: string
}

const AGENT_TEAMS_PATH_RESTORE_FUNCTION = `__orca_restore_agent_teams_path() {
  [[ -n "\${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${ORCA_AGENT_TEAMS_SHIM_DIR}"|"\${ORCA_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${ORCA_AGENT_TEAMS_SHIM_DIR}:$PATH"
}`

const OPENCODE_CONFIG_DIR_RESTORE = `[[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"`
const MIMOCODE_HOME_RESTORE = `[[ -n "\${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${ORCA_MIMOCODE_HOME}"`
const REMOTE_CLI_BIN_DIR_RESTORE = `[[ -n "\${ORCA_REMOTE_CLI_BIN_DIR:-}" ]] && case ":$PATH:" in *:"\${ORCA_REMOTE_CLI_BIN_DIR}":*) ;; *) export PATH="\${ORCA_REMOTE_CLI_BIN_DIR}:$PATH" ;; esac`
const CODEX_HOME_RESTORE = `[[ -n "\${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="\${ORCA_CODEX_HOME}"`

const ZSH_OSC133_COMMAND_MARKER_BLOCK = `__orca_osc133_precmd() {
  local exit_code=$?
  if [[ -n "\${__orca_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __orca_in_command
  fi
  printf "\\033]133;A\\007"
}
__orca_osc133_preexec() {
  printf "\\033]133;C\\007"
  __orca_in_command=1
}
# Why: prepend so Orca captures $? before user prompt hooks can overwrite it.
precmd_functions=(__orca_osc133_precmd \${precmd_functions[@]})
preexec_functions=(__orca_osc133_preexec \${preexec_functions[@]})`

/**
 * Blocks already carrying a trailing newline (the omp wrapper, the codex
 * preflight, the shared source/restore templates) keep it, so joining on a
 * single newline reproduces the blank-line spacing of the originals.
 */
function joinBlocks(blocks: (string | null)[]): string {
  return blocks.filter((block): block is string => block !== null).join('\n')
}

/** The env/PATH restores that must outlast the user's own startup files. */
function getRestoreLines(
  spec: ZshStartupWrapperSpec,
  indent: string,
  legacyFormatting?: ZshWrapperLegacyFormatting
): (string | null)[] {
  const mimocodeIndent = legacyFormatting?.unindentedMimocodeRestore ? '' : indent
  const codexHomeComment = legacyFormatting?.codexHomeRestoreComment
  return [
    `${indent}${OPENCODE_CONFIG_DIR_RESTORE}`,
    `${mimocodeIndent}${MIMOCODE_HOME_RESTORE}`,
    spec.restores.remoteCliBinDir ? `${indent}${REMOTE_CLI_BIN_DIR_RESTORE}` : null,
    `${indent}${getPosixOmpShellWrapper()}`,
    spec.restores.codexHome && codexHomeComment ? `${indent}${codexHomeComment}` : null,
    spec.restores.codexHome ? `${indent}${CODEX_HOME_RESTORE}` : null,
    ZSH_HISTFILE_RESTORE_BLOCK,
    spec.restores.codexLaunchPreflight ? `${indent}${getPosixCodexShellLaunchPreflight()}` : null
  ]
}

function buildZshrc(spec: ZshStartupWrapperSpec): string {
  return `${joinBlocks([
    `# ${spec.headerLabel}`,
    getZshStartupFileSourceBlock({
      fileName: '.zshrc',
      homeExpression: spec.homeExpression,
      interactiveOnly: true,
      skipWhenHomeIsCurrentZdotdir: spec.skipUserZshrcWhenHomeIsWrapperDir
    }),
    spec.restores.agentTeamsPath
      ? `${AGENT_TEAMS_PATH_RESTORE_FUNCTION}\n[[ ! -o login ]] && __orca_restore_agent_teams_path`
      : null,
    joinBlocks([
      'if [[ ! -o login ]]; then',
      `  ${spec.interactiveRestoreComment}`,
      ...getRestoreLines(spec, '  ', spec.legacyFormatting),
      'fi'
    ]),
    spec.osc133CommandMarkers ? ZSH_OSC133_COMMAND_MARKER_BLOCK : null,
    `if [[ ! -o login ]]; then\n${getZshFinalZdotdirRestoreBlock(spec.homeExpression)}\nfi`
  ])}\n`
}

function buildZlogin(spec: ZshStartupWrapperSpec): string {
  const finalZdotdirRestore = getZshFinalZdotdirRestoreBlock(spec.homeExpression)
  const readyMarker = getZshShellReadyMarkerRegistrationBlock(spec.readyMarkerEscaped)
  const tail =
    spec.readyMarkerOrder === 'before-zdotdir-restore'
      ? [readyMarker, finalZdotdirRestore]
      : [finalZdotdirRestore, readyMarker]

  return `${joinBlocks([
    `# ${spec.headerLabel}`,
    getZshStartupFileSourceBlock({
      fileName: '.zlogin',
      homeExpression: spec.homeExpression,
      interactiveOnly: true
    }),
    spec.restores.agentTeamsPath
      ? `${AGENT_TEAMS_PATH_RESTORE_FUNCTION}\n__orca_restore_agent_teams_path`
      : null,
    joinBlocks([spec.loginRestoreComment, ...getRestoreLines(spec, '')]),
    ...tail
  ])}\n`
}

export function buildZshStartupWrapperFiles(spec: ZshStartupWrapperSpec): ZshStartupWrapperFiles {
  return {
    zshenv:
      spec.zshenvStrategy === 'discover-user-zdotdir'
        ? getZshEnvTemplate(spec.zshDir, spec.headerLabel)
        : getZshOverlayEnvTemplate(spec.zshDir, spec.headerLabel),
    zprofile: `${joinBlocks([
      `# ${spec.headerLabel}`,
      getZshStartupFileSourceBlock({
        fileName: '.zprofile',
        homeExpression: spec.homeExpression
      })
    ])}\n`,
    zshrc: buildZshrc(spec),
    zlogin: buildZlogin(spec)
  }
}
