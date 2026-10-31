import { getLegacyOpenCodeEnvKeysToDelete } from '../../opencode/legacy-shared-config-dir'
import { restoreManagedDataAccountEnvironment } from '../../../shared/managed-data-account-environment'
import { restoreOrStripOverlayEnv } from '../../../shared/agent-overlay-env'
import { delimiter } from 'node:path'
import { dropInheritedOrcaFishHistory } from '../../fish-history-session'
import { removeAppImageRuntimeEnv } from '../../pty/appimage-terminal-env'
import { removeChromiumDisabledSessionBus } from '../../pty/chromium-session-bus-env'
import { stripInheritedBuildModeEnv } from '../../pty/build-mode-env'
import { stripPiProcessOwnerEnv } from '../../pty/pi-process-owner-env'
import { dropIncoherentCondaActivationEnv } from '../../pty/conda-activation-env'
import { stripLegacyTerminalShimEnv } from '../../pty/legacy-terminal-shim-dir'
import { removeInheritedNoColor } from '../../pty/terminal-color-env'
import { resolvePathEnvKey } from '../../pty/windows-environment-path'
import { dropInheritedOrcaHistFile } from '../../worktree-history-file-path'
import {
  gitCredentialPromptGuardEnv,
  mergeGitConfigEnvProtocol
} from '../../../shared/git-credential-prompt-env'
import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../../../shared/terminal-git-credential-guard'
import {
  ORCA_IMAGE_PROTOCOL_ENV,
  ORCA_IMAGE_PROTOCOL_VALUE
} from '../../../shared/terminal-image-protocol'
import {
  expandWindowsEnvironmentVariables,
  expandWindowsPathEnvironmentVariables
} from '../../../shared/windows-environment-expansion'
import { applyScrubSafeAgentEnvAliases } from '../../../shared/agent-hook-scrub-safe-env'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { PtySubprocessOptions } from '../pty-subprocess'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../../shared/orcad-managed-launch-env'
import { REMOTE_VIEWER_CLIPBOARD_ENV } from '../../../shared/remote-viewer-clipboard-env'
import { ORCAD_IDLE_TIMEOUT_ENV } from '../../../shared/orcad-idle-exit'

const PANE_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  // Not identity but equally per-spawn: an inherited copy names another launch's CLI.
  'ORCA_WSL_CLI_DIR',
  'JCODE_RUNTIME_DIR',
  // Per-viewer: an Orca started from a remote viewer's pane must not mark its own local panes.
  REMOTE_VIEWER_CLIPBOARD_ENV,
  // A server's own launch marker; a user's `orcad` in this shell is not client-managed.
  ORCAD_MANAGED_ACTIVATION_ROOT_ENV,
  // A WSL server's idle window; an `orcad` started from its shell must keep the default.
  ORCAD_IDLE_TIMEOUT_ENV
] as const
const WINDOWS_PATH_ENV_KEY_RE = /^path$/i

function composeGuardedDaemonGitConfigEnv(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined,
  launchAgent: TuiAgent | undefined
): void {
  const policy = explicitEnv?.[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]
  delete env[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]
  if (policy !== 'guard' && launchAgent === undefined) {
    return
  }
  // Preserve the long-lived daemon’s inherited Git config while appending the guard.
  Object.assign(env, gitCredentialPromptGuardEnv(env, process.platform))
}

function deleteRequestedDaemonEnvKeys(
  env: Record<string, string>,
  keys: readonly string[] | undefined
): void {
  const userDataPath = process.env.ORCA_USER_DATA_PATH
  if (userDataPath) {
    for (const key of getLegacyOpenCodeEnvKeysToDelete(env, userDataPath, {})) {
      delete env[key]
    }
  }
  // Persistent daemon state may differ from Electron; remove CODEX_HOME only if its Orca overlay owns it.
  const deleteOrcaOwnedCodexHome =
    keys?.includes('ORCA_CODEX_HOME') === true &&
    env.ORCA_CODEX_HOME !== undefined &&
    env.CODEX_HOME === env.ORCA_CODEX_HOME
  // A merged caller config can supersede the daemon's recorded overlay source.
  if (
    keys?.includes('ORCA_OPENCODE_CONFIG_DIR') &&
    (env.OPENCODE_CONFIG_DIR === undefined ||
      env.OPENCODE_CONFIG_DIR === env.ORCA_OPENCODE_CONFIG_DIR)
  ) {
    restoreOrStripOverlayEnv(
      env,
      {
        primary: 'OPENCODE_CONFIG_DIR',
        overlay: 'ORCA_OPENCODE_CONFIG_DIR',
        source: 'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
      },
      {}
    )
  }
  for (const key of keys ?? []) {
    delete env[key]
  }
  if (deleteOrcaOwnedCodexHome) {
    delete env.CODEX_HOME
  }
}

function removeUnspecifiedPaneIdentityEnv(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  for (const key of PANE_IDENTITY_ENV_KEYS) {
    if (!explicitEnv || !Object.hasOwn(explicitEnv, key)) {
      delete env[key]
    }
  }
}

/** Removes the second PATH key only when the daemon's env merge created it. */
function collapseWindowsPathEnvKeys(
  env: Record<string, string>,
  requestedEnv: Record<string, string> | undefined
): void {
  if (process.platform !== 'win32') {
    return
  }
  const pathKeys = Object.keys(env).filter((key) => WINDOWS_PATH_ENV_KEY_RE.test(key))
  if (pathKeys.length < 2) {
    return
  }
  // A single explicit PATH spelling is authoritative; otherwise preserve inherited keys.
  const requestedKeys = requestedEnv
    ? Object.keys(requestedEnv).filter((key) => WINDOWS_PATH_ENV_KEY_RE.test(key))
    : []
  if (requestedKeys.length !== 1) {
    return
  }
  const survivingKey = requestedKeys[0]
  if (!survivingKey || env[survivingKey] === undefined) {
    return
  }
  for (const key of pathKeys) {
    if (key !== survivingKey) {
      delete env[key]
    }
  }
}

function promoteAgentTeamsShimPath(
  env: Record<string, string>,
  requestedPath: string | undefined
): void {
  if (!env.ORCA_AGENT_TEAMS_TEAM_ID || !requestedPath) {
    return
  }
  const normalizedRequestedPath =
    process.platform === 'win32'
      ? expandWindowsEnvironmentVariables(requestedPath, env)
      : requestedPath
  const pathDelimiter = process.platform === 'win32' ? ';' : delimiter
  const shimDir = normalizedRequestedPath.split(pathDelimiter)[0]
  if (!shimDir) {
    return
  }
  const pathKey = resolvePathEnvKey(env, process.platform)
  const currentParts = env[pathKey]?.split(pathDelimiter).filter(Boolean) ?? []
  env[pathKey] = [shimDir, ...currentParts.filter((part) => part !== shimDir)].join(pathDelimiter)
}

/** A dev receiver without an endpoint file must not fall back to another runtime's file. */
function removeInheritedDevAgentHookEndpoint(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  if (explicitEnv?.ORCA_AGENT_HOOK_ENV === 'development' && !explicitEnv.ORCA_AGENT_HOOK_ENDPOINT) {
    // Preserve explicit endpoints used by hooks that scrub token-like environment variables.
    delete env.ORCA_AGENT_HOOK_ENDPOINT
  }
}

/** A persistent daemon's inherited environment cannot supply ownership for a new pane. */
export function createDaemonPtyEnvironment(opts: PtySubprocessOptions): Record<string, string> {
  const inheritedEnv = stripInheritedBuildModeEnv(process.env)
  restoreManagedDataAccountEnvironment(inheritedEnv)
  const env: Record<string, string> = {
    ...mergeGitConfigEnvProtocol(inheritedEnv, opts.env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Orca',
    TERM_PROGRAM_VERSION: process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
    FORCE_HYPERLINK: '1',
    [ORCA_IMAGE_PROTOCOL_ENV]: ORCA_IMAGE_PROTOCOL_VALUE
  } satisfies Record<string, string>
  stripLegacyTerminalShimEnv(env, process.platform)
  composeGuardedDaemonGitConfigEnv(env, opts.env, opts.launchAgent)
  deleteRequestedDaemonEnvKeys(env, opts.envToDelete)
  if (opts.env?.TERM) {
    env.TERM = opts.env.TERM
  }
  removeUnspecifiedPaneIdentityEnv(env, opts.env)
  stripPiProcessOwnerEnv(env)
  if (opts.env?.fish_history === undefined) {
    dropInheritedOrcaFishHistory(env)
  }
  if (opts.env?.HISTFILE === undefined) {
    dropInheritedOrcaHistFile(env)
  }
  if (opts.env?.ORCA_HISTFILE === undefined) {
    delete env.ORCA_HISTFILE
  }
  removeInheritedDevAgentHookEndpoint(env, opts.env)
  delete env.ELECTRON_RUN_AS_NODE
  removeAppImageRuntimeEnv(env)
  removeChromiumDisabledSessionBus(env)
  removeInheritedNoColor(env)
  // Mirror pane identity only after stripping, so aliases cannot retain removed ownership.
  applyScrubSafeAgentEnvAliases(env)
  env.LANG ??= 'en_US.UTF-8'
  return env
}

/** Platform launch preparation must not undo the caller's explicit environment deletions. */
export function rescrubDaemonPtyEnvironment(
  env: Record<string, string>,
  opts: PtySubprocessOptions
): void {
  deleteRequestedDaemonEnvKeys(env, opts.envToDelete)
  if (opts.env?.TERM) {
    env.TERM = opts.env.TERM
  }
}

/** Shell preparation can restore ambient state, so pane isolation is enforced again here. */
export function finalizeDaemonPtyEnvironment(
  env: Record<string, string>,
  requestedEnv: Record<string, string> | undefined
): void {
  expandWindowsPathEnvironmentVariables(env)
  collapseWindowsPathEnvKeys(env, requestedEnv)
  const requestedPath = requestedEnv
    ? requestedEnv[resolvePathEnvKey(requestedEnv, process.platform)]
    : undefined
  promoteAgentTeamsShimPath(env, requestedPath)
  stripLegacyTerminalShimEnv(env, process.platform)
  dropIncoherentCondaActivationEnv(env, process.platform)
  stripPiProcessOwnerEnv(env)
  // A live daemon pins this runtime across app updates; callers cannot name the host executable.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ORCA_AGENT_HOOK_NODE') {
      delete env[key]
    }
  }
  if (process.platform === 'win32') {
    env.ORCA_AGENT_HOOK_NODE = process.execPath
  }
}
