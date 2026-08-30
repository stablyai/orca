import { release as osRelease } from 'node:os'
import { win32 as pathWin32 } from 'node:path'
import { shouldUseShellReadyStartupDelivery } from '../../shared/codex-startup-delivery'
import { expandWindowsPathEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { dropInheritedOrcaFishHistory } from '../fish-history-session'
import { isWindowsGitBashShellPath } from '../git-bash'
import { dropIncoherentCondaActivationEnv } from '../pty/conda-activation-env'
import { stripLegacyTerminalShimEnv } from '../pty/legacy-terminal-shim-dir'
import {
  POWERLEVEL10K_WIZARD_DISABLE_ENV,
  seedPowerlevel10kWizardEnv
} from '../pty/powerlevel10k-wizard-env'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import { resolvePathEnvKey } from '../pty/windows-environment-path'
import {
  shellCommandMarkerEnv,
  SHELL_COMMAND_NONCE_ENV,
  SHELL_INTEGRATION_CONTEXT_ENV
} from '../shell-command-marker-template'
import {
  isShellCommandMarkerInjectionEnabled,
  resolvePowerShellCommandMarkerTrust,
  scrubShellCommandMarkerPolicyEnv
} from '../shell-integration-injection-policy'
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
    // Why: payload-bearing Codex startup can be lost to rc-file noise; plain Codex stays markerless for startup speed.
    const waitsForShellReady =
      Boolean(spawn.command) &&
      (!isCodexStartupCommand ||
        shouldUseShellReadyStartupDelivery({
          command: spawn.command as string,
          startupCommandDelivery: spawn.startupCommandDelivery
        }))
    // Why delete: ORCA_SHELL_FEATURES is Orca-owned, and only the launch
    // config below may name features for this shell.
    delete env.ORCA_SHELL_FEATURES
    delete env[SHELL_COMMAND_NONCE_ENV]
    delete env[SHELL_INTEGRATION_CONTEXT_ENV]
    plan.getFallbackShellReadyConfig = (shell) =>
      getShellLaunchConfig(
        shell,
        selectShellStartupFeatures({
          shellPath: shell,
          env,
          hasStartupCommand: Boolean(spawn.command),
          waitsForShellReady,
          // Why identical: the identity marker exists so the readiness
          // handshake can bind output to the right shell PID.
          emitsStartupIdentity: waitsForShellReady,
          injectsCommandMarkers: true
        }),
        { commandNonce: plan.commandNonce, hostClass: 'local-native' }
      )
    const shellLaunch = plan.getFallbackShellReadyConfig(plan.shellPath)
    Object.assign(env, shellLaunch.env)
    plan.shellArgs = shellLaunch.args ?? plan.shellArgs
    plan.shellReadyLaunch = shellLaunch
    plan.primaryLaunchEnvKeys = Object.keys(shellLaunch.env)
  }

  if (process.platform === 'win32') {
    delete env[SHELL_COMMAND_NONCE_ENV]
    delete env[SHELL_INTEGRATION_CONTEXT_ENV]
    const shellBasename = pathWin32.basename(plan.shellPath).toLowerCase()
    if (shellBasename === 'wsl.exe' && isShellCommandMarkerInjectionEnabled('local-wsl')) {
      const waitsForShellReady = Boolean(spawn.command)
      env.ORCA_SHELL_FEATURES = waitsForShellReady ? 'markers,ready,identity' : 'markers'
      Object.assign(env, shellCommandMarkerEnv(plan.commandNonce))
      addOrcaWslInteropEnv(env)
    } else if (
      (shellBasename === 'pwsh.exe' || shellBasename === 'powershell.exe') &&
      isShellCommandMarkerInjectionEnabled('local-native')
    ) {
      plan.expectedCommandNonce = resolvePowerShellCommandMarkerTrust(process.platform, osRelease())
        ? plan.commandNonce
        : null
      Object.assign(env, shellCommandMarkerEnv(plan.expectedCommandNonce))
      plan.primaryLaunchEnvKeys.push(SHELL_COMMAND_NONCE_ENV, SHELL_INTEGRATION_CONTEXT_ENV)
    } else if (
      isWindowsGitBashShellPath(plan.shellPath) &&
      isShellCommandMarkerInjectionEnabled('local-native')
    ) {
      env.ORCA_SHELL_FEATURES = 'markers'
      Object.assign(env, shellCommandMarkerEnv(plan.commandNonce))
    }
  }
  scrubShellCommandMarkerPolicyEnv(env)
  return historyResult
}
