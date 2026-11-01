import { win32 as pathWin32 } from 'node:path'
import { shouldUseShellReadyStartupDelivery } from '../../shared/codex-startup-delivery'
import { expandWindowsPathEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { dropInheritedOrcaFishHistory } from '../fish-history-session'
import { dropIncoherentCondaActivationEnv } from '../pty/conda-activation-env'
import { stripLegacyTerminalShimEnv } from '../pty/legacy-terminal-shim-dir'
import {
  POWERLEVEL10K_WIZARD_DISABLE_ENV,
  seedPowerlevel10kWizardEnv
} from '../pty/powerlevel10k-wizard-env'
import {
  POSIX_SHELL_STARTUP_COMMAND_ENV,
  supportsPosixShellStartupCommand
} from '../pty/posix-shell-startup-command'
import { resolvePathEnvKey } from '../pty/windows-environment-path'
import { selectShellStartupFeatures } from '../shell-startup-features'
import {
  injectHistoryEnv,
  injectWslFishHistoryEnv,
  logHistoryInjection,
  type HistoryInjectionResult
} from '../terminal-history'
import { addWslEnvKeys } from '../wsl-env'
import { dropInheritedOrcaHistFile } from '../worktree-history-file-path'
import { promoteAgentTeamsShimPath } from './local-pty-launch-helpers'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import { getShellLaunchConfig } from './local-pty-shell-ready'
import { finalizeWindowsLocalPtySpawnEnvironment } from './local-pty-windows-spawn-environment'
import type { PtySpawnOptions } from './pty-provider-contract'

export function finalizeLocalPtySpawnEnvironment(args: {
  spawn: PtySpawnOptions
  getOptions: () => LocalPtyProviderOptions
  plan: LocalPtyLaunchPlan
  env: Record<string, string>
}): HistoryInjectionResult | null {
  const { spawn, getOptions, plan, env } = args
  if (process.platform === 'win32') {
    finalizeWindowsLocalPtySpawnEnvironment({ spawn, plan, env })
  }
  seedPowerlevel10kWizardEnv(env, { envToDelete: spawn.envToDelete })
  if (
    env[POWERLEVEL10K_WIZARD_DISABLE_ENV] !== undefined &&
    process.platform === 'win32' &&
    pathWin32.basename(plan.shellPath).toLowerCase() === 'wsl.exe'
  ) {
    addWslEnvKeys(env, [POWERLEVEL10K_WIZARD_DISABLE_ENV])
  }
  const requestedEnv = spawn.env
  expandWindowsPathEnvironmentVariables(env)
  promoteAgentTeamsShimPath(
    env,
    requestedEnv ? requestedEnv[resolvePathEnvKey(requestedEnv, process.platform)] : undefined
  )
  // Requested PATH is promoted after the host scrub, so strip legacy shims again.
  stripLegacyTerminalShimEnv(env, process.platform)
  // envToDelete can remove CONDA_PREFIX after scrubbing; drop its now-incoherent sentinel.
  dropIncoherentCondaActivationEnv(env, process.platform)

  // Scope history per workspace to avoid sharing a global shell history.
  const worktreeId = spawn.worktreeId
  const historyEnabled = worktreeId && (getOptions().isHistoryEnabled?.() ?? true)
  // WSL launches wsl.exe outside, but history targets the inner bash shell.
  const isWslTerminal =
    Boolean(plan.wslInfo || plan.worktreeWslContext || plan.preferredWslContext) ||
    pathWin32.basename(plan.shellPath).toLowerCase() === 'wsl.exe'
  const effectiveShellPath = isWslTerminal ? 'bash' : plan.shellPath
  let historyResult: ReturnType<typeof injectHistoryEnv> | null = null
  if (historyEnabled) {
    historyResult = injectHistoryEnv(env, worktreeId, effectiveShellPath, plan.cwd, {
      wslDistro: plan.launchWslDistro
    })
    if (isWslTerminal && plan.launchWslDistro) {
      injectWslFishHistoryEnv(env, worktreeId, plan.launchWslDistro)
      addWslEnvKeys(env, ['HISTFILE', 'fish_history'])
    }
    logHistoryInjection(worktreeId, historyResult)
  } else {
    // History-off bypasses injectHistoryEnv, so clear inherited Orca history explicitly (#11146).
    delete env.ORCA_HISTFILE
    // Exported fish_history must not select the launching workspace history when isolation is off.
    dropInheritedOrcaFishHistory(env)
    // Exported HISTFILE must not select the launching workspace history when isolation is off.
    dropInheritedOrcaHistFile(env)
  }

  if (!plan.wslInfo && process.platform !== 'win32') {
    // Wrap after history injection so zsh can repair HISTFILE clobbered by system zshrc.
    const isCodexStartupCommand = plan.startupAgentRecognition?.agent === 'codex'
    const codexStartupCommand = isCodexStartupCommand ? spawn.command : undefined
    const codexRequiresShellReady =
      codexStartupCommand !== undefined &&
      shouldUseShellReadyStartupDelivery({
        command: codexStartupCommand,
        startupCommandDelivery: spawn.startupCommandDelivery
      })
    // Only this shell launch config may choose Orca-owned features.
    delete env.ORCA_SHELL_FEATURES
    delete env[POSIX_SHELL_STARTUP_COMMAND_ENV]
    const userShellArgs = !spawn.command && !spawn.launchAgent ? spawn.terminalShellArgs : undefined
    // Capture before launch config prefixes XDG_DATA_DIRS.
    const fishLaunch = {
      inheritedXdgDataDirs: env.XDG_DATA_DIRS,
      shellArgs: plan.shellArgs
    }
    plan.getFallbackShellReadyConfig = (shell) => {
      const wrapperStartupCommand =
        codexStartupCommand !== undefined && supportsPosixShellStartupCommand(shell)
          ? codexStartupCommand
          : undefined
      // Wrapped Codex runs from the prompt hook; no PTY command write needs line-editor double-echo protection.
      const waitsForShellReady =
        Boolean(spawn.command) && (!isCodexStartupCommand || codexRequiresShellReady)
      return getShellLaunchConfig(
        shell,
        selectShellStartupFeatures({
          shellPath: shell,
          env,
          hasStartupCommand: Boolean(spawn.command),
          waitsForShellReady,
          // Readiness must bind output to the shell PID through its identity marker.
          emitsStartupIdentity: waitsForShellReady
        }),
        wrapperStartupCommand,
        fishLaunch
      )
    }
    const shellLaunch = plan.getFallbackShellReadyConfig(plan.shellPath)
    plan.primaryPreLaunchEnv = Object.fromEntries(
      Object.keys(shellLaunch.env).map((key) => [key, env[key]])
    )
    Object.assign(env, shellLaunch.env)
    plan.shellArgs = userShellArgs ?? shellLaunch.args ?? plan.shellArgs
    plan.shellReadyLaunch = spawn.command ? shellLaunch : null
  }
  return historyResult
}
