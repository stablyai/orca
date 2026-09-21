import { delimiter } from 'node:path'
import { dropInheritedOrcaFishHistory } from '../../fish-history-session'
import { removeAppImageRuntimeEnv } from '../../pty/appimage-terminal-env'
import { stripInheritedBuildModeEnv } from '../../pty/build-mode-env'
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
  expandWindowsEnvironmentVariables,
  expandWindowsPathEnvironmentVariables
} from '../../../shared/windows-environment-expansion'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { PtySubprocessOptions } from '../pty-subprocess'

const PANE_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN'
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
  // Why: the daemon can outlive Electron, so its process.env is the authoritative inherited config; append only the guard.
  Object.assign(env, gitCredentialPromptGuardEnv(env, process.platform))
}

function deleteRequestedDaemonEnvKeys(
  env: Record<string, string>,
  keys: readonly string[] | undefined
): void {
  // Why: persistent daemon state can differ from Electron; delete CODEX_HOME only when its Orca overlay owns it.
  const deleteOrcaOwnedCodexHome =
    keys?.includes('ORCA_CODEX_HOME') === true &&
    env.ORCA_CODEX_HOME !== undefined &&
    env.CODEX_HOME === env.ORCA_CODEX_HOME
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
  // Why: a one-key main patch is authoritative; zero or two keys came from inherited state.
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

/** Promotes the agent-teams shim path ahead of inherited PATH entries. */
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

function removeInheritedDevAgentHookEndpoint(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  if (explicitEnv?.ORCA_AGENT_HOOK_ENV === 'development' && !explicitEnv.ORCA_AGENT_HOOK_ENDPOINT) {
    // Why: strip only stale inherited endpoints; a fresh explicit one is needed by hooks that scrub token-like env vars before exec.
    delete env.ORCA_AGENT_HOOK_ENDPOINT
  }
}

export function createDaemonPtyEnvironment(opts: PtySubprocessOptions): Record<string, string> {
  const env: Record<string, string> = {
    ...mergeGitConfigEnvProtocol(stripInheritedBuildModeEnv(process.env), opts.env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Orca',
    TERM_PROGRAM_VERSION: process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
    FORCE_HYPERLINK: '1'
  } as Record<string, string>
  stripLegacyTerminalShimEnv(env, process.platform)
  composeGuardedDaemonGitConfigEnv(env, opts.env, opts.launchAgent)
  deleteRequestedDaemonEnvKeys(env, opts.envToDelete)
  if (opts.env?.TERM) {
    env.TERM = opts.env.TERM
  }
  removeUnspecifiedPaneIdentityEnv(env, opts.env)
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
  removeInheritedNoColor(env)
  env.LANG ??= 'en_US.UTF-8'
  return env
}

export function rescrubDaemonPtyEnvironment(
  env: Record<string, string>,
  opts: PtySubprocessOptions
): void {
  deleteRequestedDaemonEnvKeys(env, opts.envToDelete)
  if (opts.env?.TERM) {
    env.TERM = opts.env.TERM
  }
}

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
}
