/**
 * The single source of the zsh startup wrapper files (.zshenv/.zprofile/.zshrc/
 * .zlogin) Orca writes for every transport: local PTY, daemon/SSH, and relay.
 *
 * Why: the three generators were copies that drifted apart, so a fix landed in
 * one transport and silently missed the other two. Everything they genuinely
 * disagree on is a field on ZshStartupWrapperSpec, so the disagreements are
 * visible in one place instead of spread across three template literals.
 *
 * Every generated file redefines the helpers it calls, so the epilogue is the
 * only thing one file needs another to have defined — see EPILOGUE_CALL.
 *
 * All order-sensitive Orca work lives in ONE `__orca_shell_epilogue` defined in
 * .zshenv and invoked exactly once — from .zshrc for a non-login shell, from
 * .zlogin for a login shell. Each feature inside it is an independent guard on
 * the allowlist snapshotted (and destroyed) at the top of .zshenv, so a pane
 * wrapped only for one feature runs only that feature's code — except the
 * HISTFILE repair, which undoes damage the wrapper's own ZDOTDIR caused and so
 * must also run for a shell that re-entered the wrapper with no allowlist.
 */
import { getPosixOmpShellWrapper } from './pty/omp-shell-wrapper'
import { getPosixCodexShellLaunchPreflight } from './pty/codex-shell-launch-preflight'
import {
  getZshEnvDiscoveryBody,
  getZshEmulationDegradeBlock,
  getZshFinalZdotdirRestoreBlock,
  getZshOverlayEnvBody,
  getZshShellReadyMarkerRegistrationBlock,
  getZshStartupFileSourceBlock,
  SHELL_STARTUP_IDENTITY_MARKER_BLOCK,
  ZSH_BOURNE_EMULATION_OPTION_HINT,
  ZSH_FEATURE_CHANNEL_BLOCK,
  ZSH_HISTFILE_RESTORE_BLOCK,
  ZSH_INHERITED_CONFIG_DIR_RESOLVER_BLOCK,
  ZSH_USER_CONFIG_DIR_RESOLVER_BLOCK
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
  /** OSC 133 command-lifecycle hooks (behind the `markers` feature). */
  osc133CommandMarkers: boolean
  /** Skip the user .zshrc when its dir is already the wrapper ZDOTDIR. */
  skipUserZshrcWhenHomeIsWrapperDir: boolean
  /** Comment heading the overlay restores inside the epilogue. */
  overlayRestoreComment: string
  restores: ZshWrapperRestoreSpec
}

export type ZshStartupWrapperFiles = {
  zshenv: string
  zprofile: string
  zshrc: string
  zlogin: string
}

const AGENT_TEAMS_PATH_RESTORE_BLOCK = `__orca_restore_agent_teams_path() {
  [[ -n "\${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${ORCA_AGENT_TEAMS_SHIM_DIR}"|"\${ORCA_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${ORCA_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
__orca_restore_agent_teams_path`

const OPENCODE_CONFIG_DIR_RESTORE = `[[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"`
const MIMOCODE_HOME_RESTORE = `[[ -n "\${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${ORCA_MIMOCODE_HOME}"`
const REMOTE_CLI_BIN_DIR_RESTORE = `[[ -n "\${ORCA_REMOTE_CLI_BIN_DIR:-}" ]] && case ":$PATH:" in *:"\${ORCA_REMOTE_CLI_BIN_DIR}":*) ;; *) export PATH="\${ORCA_REMOTE_CLI_BIN_DIR}:$PATH" ;; esac`
const CODEX_HOME_RESTORE = `# Why: Codex must keep using Orca's runtime CODEX_HOME after rc files.
[[ -n "\${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="\${ORCA_CODEX_HOME}"`

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
  # Why typeset -g: a plain assignment here creates a global inside a function,
  # which prints a warning above every command under warn_create_global.
  typeset -g __orca_in_command=1
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

function indentBlock(block: string, indent: string): string {
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? `${indent}${line}` : line))
    .join('\n')
}

/** One epilogue feature: `if __orca_has_feature <name>; then ... fi`. */
function featureGuard(name: string, body: (string | null)[]): string | null {
  const blocks = body.filter((block): block is string => block !== null)
  if (blocks.length === 0) {
    return null
  }
  return `  if __orca_has_feature ${name}; then\n${indentBlock(joinBlocks(blocks).replace(/\n$/, ''), '    ')}\n  fi`
}

/** The env/PATH restores that must outlast the user's own startup files. */
function getOverlayRestoreBlocks(spec: ZshStartupWrapperSpec): (string | null)[] {
  return [
    spec.overlayRestoreComment,
    spec.restores.agentTeamsPath ? AGENT_TEAMS_PATH_RESTORE_BLOCK : null,
    OPENCODE_CONFIG_DIR_RESTORE,
    MIMOCODE_HOME_RESTORE,
    spec.restores.remoteCliBinDir ? REMOTE_CLI_BIN_DIR_RESTORE : null,
    getPosixOmpShellWrapper(),
    spec.restores.codexHome ? CODEX_HOME_RESTORE : null,
    spec.restores.codexLaunchPreflight ? getPosixCodexShellLaunchPreflight() : null
  ]
}

/**
 * Every Orca-owned, order-sensitive step, in one function called once.
 *
 * Why a function in .zshenv rather than inline code in .zshrc/.zlogin: login and
 * non-login shells load a different last file, and duplicating the body in both
 * is how the two copies drifted before. The once-flag makes a double invocation
 * (re-sourced rc files) a no-op rather than a double-registered prompt hook.
 */
function buildEpilogue(spec: ZshStartupWrapperSpec): string {
  return `__orca_shell_epilogue() {
  # Why first: this body runs after the user's own config, so it would otherwise
  # inherit whatever options that config left set. Under NO_UNSET an unset
  # precmd_functions is a fatal error that returns from the whole epilogue
  # (skipping the ready widget and the ZDOTDIR restore), and KSH_ARRAYS makes
  # the 1-based feature lookup drop the first selected feature.
  emulate -L zsh
  (( $+_orca_epilogue_done )) && return 0
  typeset -g _orca_epilogue_done=1
${joinBlocks([
  featureGuard('overlay', getOverlayRestoreBlocks(spec)),
  // Why ungated: this repairs damage Orca's own ZDOTDIR caused, so it must also
  // run for a shell that re-enters the wrapper with no feature channel left
  // (a nested zsh under an inherited wrapper ZDOTDIR) — the plain #11044 shape.
  indentBlock(ZSH_HISTFILE_RESTORE_BLOCK, '  '),
  featureGuard('markers', [spec.osc133CommandMarkers ? ZSH_OSC133_COMMAND_MARKER_BLOCK : null]),
  featureGuard('ready', [getZshShellReadyMarkerRegistrationBlock(spec.readyMarkerEscaped)])
])}
${indentBlock(getZshFinalZdotdirRestoreBlock(spec.homeExpression).replace(/\n$/, ''), '  ')}
  unset _orca_shell_features
  unfunction __orca_shell_epilogue __orca_has_feature __orca_resolve_user_config_dir __orca_resolve_inherited_config_dir
}`
}

function buildZshenv(spec: ZshStartupWrapperSpec): string {
  return `${joinBlocks([
    `# ${spec.headerLabel}`,
    ZSH_FEATURE_CHANNEL_BLOCK,
    SHELL_STARTUP_IDENTITY_MARKER_BLOCK,
    ZSH_USER_CONFIG_DIR_RESOLVER_BLOCK,
    ZSH_INHERITED_CONFIG_DIR_RESOLVER_BLOCK,
    spec.zshenvStrategy === 'discover-user-zdotdir'
      ? getZshEnvDiscoveryBody(spec.zshDir)
      : getZshOverlayEnvBody(spec.zshDir),
    buildEpilogue(spec)
  ])}\n`
}

/**
 * Why guarded: one wrapper dir can be shared by two concurrently installed Orca
 * builds, so a shell can read one build's .zshenv and another's .zshrc/.zlogin.
 * The epilogue is the only cross-file dependency left — every other function
 * these files call is redefined at the top of each of them — so an older .zshenv
 * costs this shell the epilogue's features and nothing else, without printing
 * "command not found" into the user's pane. Braced subscript because sh/ksh
 * emulation (KSH_ARRAYS) rejects the unbraced `$+functions[...]` form outright.
 */
const EPILOGUE_CALL = '(( ${+functions[__orca_shell_epilogue]} )) && __orca_shell_epilogue'

/**
 * A login shell normally runs the epilogue from .zlogin, after the user's own
 * .zlogin. The exception: zsh's `sourcehome()` ignores ZDOTDIR once the shell is
 * in sh/ksh emulation, so a user .zshrc ending in `emulate sh` makes zsh read
 * $HOME/.zlogin and never the wrapper's — no OSC 133 hooks, no ready widget, and
 * HISTFILE left pointing inside the wrapper dir. Running the epilogue here
 * instead means the user's own .zlogin can undo its overlay restores, which
 * beats not running it at all. An older zsh whose `emulate` has no query form
 * prints nothing, fails the comparison, and runs it here too; the epilogue's
 * once-flag makes the later .zlogin call a no-op.
 *
 * Of the wrapper's three emulation probes this is the costliest — it forks a
 * zsh that has just finished loading the user's whole .zshrc — so
 * ZSH_BOURNE_EMULATION_OPTION_HINT skips it for any shell not in Bourne
 * emulation. Braces because `A || B && C` groups as `(A || B) && C` in a shell.
 */
const ZSHRC_EPILOGUE_INVOCATION = `if [[ ! -o login ]] || { ${ZSH_BOURNE_EMULATION_OPTION_HINT} && [[ "$(emulate 2>/dev/null)" != zsh ]]; }; then
  ${EPILOGUE_CALL}
fi`

export function buildZshStartupWrapperFiles(spec: ZshStartupWrapperSpec): ZshStartupWrapperFiles {
  return {
    zshenv: buildZshenv(spec),
    zprofile: `${joinBlocks([
      `# ${spec.headerLabel}`,
      ZSH_USER_CONFIG_DIR_RESOLVER_BLOCK,
      getZshStartupFileSourceBlock({
        fileName: '.zprofile',
        homeExpression: spec.homeExpression
      }),
      // Why here too: a user .zprofile ending in `emulate sh` hides .zshrc and
      // .zlogin from the wrapper exactly as a user .zshenv does, and .zprofile
      // is the last wrapper file that still runs before /etc/zshrc clobbers
      // HISTFILE — so this is the last point where degrading cleanly is possible.
      getZshEmulationDegradeBlock({
        userZdotdirExpression: '"$_orca_home"',
        sourcedUserFileTest: '-f "$_orca_home/.zprofile"'
      })
    ])}\n`,
    zshrc: `${joinBlocks([
      `# ${spec.headerLabel}`,
      ZSH_USER_CONFIG_DIR_RESOLVER_BLOCK,
      getZshStartupFileSourceBlock({
        fileName: '.zshrc',
        homeExpression: spec.homeExpression,
        interactiveOnly: true,
        skipWhenHomeIsCurrentZdotdir: spec.skipUserZshrcWhenHomeIsWrapperDir
      }),
      ZSHRC_EPILOGUE_INVOCATION
    ])}\n`,
    zlogin: `${joinBlocks([
      `# ${spec.headerLabel}`,
      ZSH_USER_CONFIG_DIR_RESOLVER_BLOCK,
      getZshStartupFileSourceBlock({
        fileName: '.zlogin',
        homeExpression: spec.homeExpression,
        interactiveOnly: true
      }),
      EPILOGUE_CALL
    ])}\n`
  }
}
