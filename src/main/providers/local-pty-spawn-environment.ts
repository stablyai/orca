import { mergeGitConfigEnvProtocol } from '../../shared/git-credential-prompt-env'
import { restoreManagedDataAccountEnvironment } from '../../shared/managed-data-account-environment'
import {
  ORCA_IMAGE_PROTOCOL_ENV,
  ORCA_IMAGE_PROTOCOL_VALUE
} from '../../shared/terminal-image-protocol'
import { removeAppImageRuntimeEnv } from '../pty/appimage-terminal-env'
import { removeChromiumDisabledSessionBus } from '../pty/chromium-session-bus-env'
import { stripInheritedBuildModeEnv } from '../pty/build-mode-env'
import { stripPiProcessOwnerEnv } from '../pty/pi-process-owner-env'
import { removeInheritedNoColor } from '../pty/terminal-color-env'
import { isWindowsGitBashShellPath } from '../git-bash'
import { applyScrubSafeAgentEnvAliases } from '../../shared/agent-hook-scrub-safe-env'
import { removeUnspecifiedPaneIdentityEnv } from './local-pty-launch-helpers'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import type { PtySpawnOptions } from './pty-provider-contract'

/** Pane ownership must be fresh even when Orca itself was launched inside an agent. */
export function buildLocalPtySpawnEnvironment(args: {
  id: string
  spawn: PtySpawnOptions
  getOptions: () => LocalPtyProviderOptions
  plan: LocalPtyLaunchPlan
}): Record<string, string> | Promise<Record<string, string>> {
  const { id, spawn, getOptions, plan } = args
  const spawnEnv = buildInheritedLocalPtyEnvironment(spawn.env, spawn.envToDelete)

  // Windows LANG cannot set Python console encoding; PYTHONUTF8 prevents garbled CJK stdio.
  if (process.platform === 'win32') {
    spawnEnv.PYTHONUTF8 ??= '1'
    if (isWindowsGitBashShellPath(plan.shellPath)) {
      // Git login files otherwise cd to HOME instead of the requested terminal cwd.
      spawnEnv.CHERE_INVOKING ??= '1'
    }
  }

  if (!getOptions().buildSpawnEnv) {
    return spawnEnv
  }
  return getOptions().buildSpawnEnv!(id, spawnEnv, {
    explicitEnv: spawn.env ?? {},
    command: spawn.command,
    launchAgent: spawn.launchAgent,
    codexHomePathOverride: spawn.codexHomePathOverride,
    cwd: plan.cwd,
    shellPath: plan.shellPath,
    isWsl: plan.isWslShell,
    wslDistro: plan.launchWslDistro,
    // Main's background starts get the same E9 prep as a passive restore (STA-12870).
    wslPassiveRestore: spawn.wslPassiveRestore === true || spawn.wslBackgroundStart === true
  })
}

export function buildInheritedLocalPtyEnvironment(
  explicitEnv: Record<string, string> | undefined,
  envToDelete: readonly string[] = []
): Record<string, string> {
  const inheritedEnv = stripInheritedBuildModeEnv(process.env)
  restoreManagedDataAccountEnvironment(inheritedEnv)
  const spawnEnv: Record<string, string> = {
    ...mergeGitConfigEnvProtocol(inheritedEnv, explicitEnv),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Orca',
    // TUIs gate features on version; plain-node/test launches lack the app version.
    TERM_PROGRAM_VERSION: process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
    // supports-hyperlinks rejects Orca by name despite xterm supporting OSC 8; force support.
    FORCE_HYPERLINK: '1',
    [ORCA_IMAGE_PROTOCOL_ENV]: ORCA_IMAGE_PROTOCOL_VALUE
  } satisfies Record<string, string>
  removeUnspecifiedPaneIdentityEnv(spawnEnv, explicitEnv)
  stripPiProcessOwnerEnv(spawnEnv)
  removeAppImageRuntimeEnv(spawnEnv)
  removeChromiumDisabledSessionBus(spawnEnv)
  removeInheritedNoColor(spawnEnv)
  for (const key of envToDelete) {
    delete spawnEnv[key]
  }
  if (explicitEnv?.TERM) {
    spawnEnv.TERM = explicitEnv.TERM
  }
  // Create aliases after stripping/deletion so none outlives its source value.
  applyScrubSafeAgentEnvAliases(spawnEnv)

  spawnEnv.LANG ??= 'en_US.UTF-8'
  return spawnEnv
}

/** App-level env builders can reintroduce deleted keys; enforce isolation after they finish. */
export function enforceLocalPtySpawnEnvironmentOverrides(
  spawn: PtySpawnOptions,
  finalEnv: Record<string, string>
): void {
  stripPiProcessOwnerEnv(finalEnv)
  for (const key of spawn.envToDelete ?? []) {
    delete finalEnv[key]
  }
  if (spawn.env?.TERM) {
    finalEnv.TERM = spawn.env.TERM
  }
}
