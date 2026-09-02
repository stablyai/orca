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
import type { PtySpawnOptions } from './types'

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
  // Why: raw requested PATH promotion runs after the host-env scrub.
  stripLegacyTerminalShimEnv(env, process.platform)
  // Why after every deletion pass: an envToDelete of CONDA_PREFIX must not leave the sentinel behind.
  dropIncoherentCondaActivationEnv(env, process.platform)

  // Why: worktree-scoped HISTFILE — without it worktrees share one global history (terminal-history-scope-design §7–§10).
  const worktreeId = spawn.worktreeId
  const historyEnabled = worktreeId && (getOptions().isHistoryEnabled?.() ?? true)
  // Effective shell for history injection: WSL's outer exe is wsl.exe but the inner login shell is bash.
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
    // Why: injectHistoryEnv is what normally clears it, so when history is off
    // an inherited ORCA_HISTFILE would still reach the wrapper. Credit: #11146.
    delete env.ORCA_HISTFILE
    // Same for an exported `fish_history` from the fish pane that launched this
    // Orca: history off means fish's own default, not another worktree's file.
    dropInheritedOrcaFishHistory(env)
    // And for an exported HISTFILE: history off means the shell's own default,
    // not the history file of the worktree this Orca was launched from.
    dropInheritedOrcaHistFile(env)
  }

  if (!plan.wslInfo && process.platform !== 'win32') {
    // Why after history injection: the wrapper is what repairs a worktree
    // HISTFILE that the system zshrc clobbers, so the decision to wrap has to
    // see whether this spawn actually injected one.
    const isCodexStartupCommand = plan.startupAgentRecognition?.agent === 'codex'
    const codexStartupCommand = isCodexStartupCommand ? spawn.command : undefined
    const codexRequiresShellReady =
      codexStartupCommand !== undefined &&
      shouldUseShellReadyStartupDelivery({
        command: codexStartupCommand,
        startupCommandDelivery: spawn.startupCommandDelivery
      })
    // Why delete: ORCA_SHELL_FEATURES is Orca-owned, and only the launch
    // config below may name features for this shell.
    delete env.ORCA_SHELL_FEATURES
    delete env[POSIX_SHELL_STARTUP_COMMAND_ENV]
    plan.getFallbackShellReadyConfig = (shell) => {
      const wrapperStartupCommand =
        codexStartupCommand !== undefined && supportsPosixShellStartupCommand(shell)
          ? codexStartupCommand
          : undefined
      const waitsForShellReady =
        Boolean(spawn.command) && (!isCodexStartupCommand || codexRequiresShellReady)
      return getShellLaunchConfig(
        shell,
        selectShellStartupFeatures({
          shellPath: shell,
          env,
          hasStartupCommand: Boolean(spawn.command),
          waitsForShellReady,
          // Why identical: the identity marker exists so the readiness
          // handshake can bind output to the right shell PID.
          emitsStartupIdentity: waitsForShellReady
        }),
        wrapperStartupCommand
      )
    }
    const shellLaunch = plan.getFallbackShellReadyConfig(plan.shellPath)
    Object.assign(env, shellLaunch.env)
    plan.shellArgs = shellLaunch.args ?? plan.shellArgs
    plan.shellReadyLaunch = spawn.command ? shellLaunch : null
    plan.primaryLaunchEnvKeys = Object.keys(shellLaunch.env)
  }
  return historyResult
}
