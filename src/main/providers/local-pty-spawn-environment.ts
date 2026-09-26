import { mergeGitConfigEnvProtocol } from '../../shared/git-credential-prompt-env'
import {
  ORCA_IMAGE_PROTOCOL_ENV,
  ORCA_IMAGE_PROTOCOL_VALUE
} from '../../shared/terminal-image-protocol'
import { removeAppImageRuntimeEnv } from '../pty/appimage-terminal-env'
import { stripInheritedBuildModeEnv } from '../pty/build-mode-env'
import { stripPiProcessOwnerEnv } from '../pty/pi-process-owner-env'
import { removeInheritedNoColor } from '../pty/terminal-color-env'
import { isWindowsGitBashShellPath } from '../git-bash'
import { removeUnspecifiedPaneIdentityEnv } from './local-pty-launch-helpers'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import type { PtySpawnOptions } from './types'

/** Pane ownership must be fresh even when Orca itself was launched inside an agent. */
export function buildLocalPtySpawnEnvironment(args: {
  id: string
  spawn: PtySpawnOptions
  getOptions: () => LocalPtyProviderOptions
  plan: LocalPtyLaunchPlan
}): Record<string, string> | Promise<Record<string, string>> {
  const { id, spawn, getOptions, plan } = args
  const spawnEnv: Record<string, string> = {
    ...mergeGitConfigEnvProtocol(stripInheritedBuildModeEnv(process.env), spawn.env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Orca',
    // Why: TUIs feature-gate on TERM_PROGRAM_VERSION; the fallback keeps tests and non-Electron runs working.
    TERM_PROGRAM_VERSION: process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
    // Why: supports-hyperlinks rejects TERM_PROGRAM=Orca, so tools drop OSC 8 links; force it since xterm.js parses them.
    FORCE_HYPERLINK: '1',
    [ORCA_IMAGE_PROTOCOL_ENV]: ORCA_IMAGE_PROTOCOL_VALUE
  } satisfies Record<string, string>
  removeUnspecifiedPaneIdentityEnv(spawnEnv, spawn.env)
  stripPiProcessOwnerEnv(spawnEnv)
  removeAppImageRuntimeEnv(spawnEnv)
  removeInheritedNoColor(spawnEnv)
  for (const key of spawn.envToDelete ?? []) {
    delete spawnEnv[key]
  }
  if (spawn.env?.TERM) {
    spawnEnv.TERM = spawn.env.TERM
  }

  spawnEnv.LANG ??= 'en_US.UTF-8'

  // Why: on Windows LANG doesn't set the console code page; PYTHONUTF8=1 forces Python UTF-8 stdio to avoid garbled CJK.
  if (process.platform === 'win32') {
    spawnEnv.PYTHONUTF8 ??= '1'
    if (isWindowsGitBashShellPath(plan.shellPath)) {
      // Why: Git for Windows login files otherwise cd to $HOME, ignoring node-pty's cwd for repo-scoped terminals.
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
    wslDistro: plan.launchWslDistro
  })
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
