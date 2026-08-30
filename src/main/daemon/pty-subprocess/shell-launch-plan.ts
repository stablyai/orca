import { win32 as pathWin32 } from 'node:path'
import { isWindowsGitBashShellPath, resolveWindowsGitBashShellPath } from '../../git-bash'
import { isPwshAvailable } from '../../pwsh'
import { isHostCodexHomeForWsl, isWslCodexHomeForHost } from '../../pty/codex-home-wsl-env'
import { addOrcaWslInteropEnv } from '../../pty/wsl-orca-env'
import {
  POWERLEVEL10K_WIZARD_DISABLE_ENV,
  seedPowerlevel10kWizardEnv
} from '../../pty/powerlevel10k-wizard-env'
import {
  resolveSafePtyDefaultCwd,
  assertSafeAgentStartupCwd
} from '../../providers/pty-default-cwd'
import {
  resolveEffectiveWindowsPowerShell,
  shouldProbeWindowsPowerShellAvailability,
  type WindowsPowerShellShellFamily
} from '../../providers/windows-powershell'
import {
  buildWindowsPowerShellSpawnAttempts,
  type WindowsShellSpawnAttempt
} from '../../providers/windows-shell-fallback-chain'
import {
  ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE_ENV,
  resolveWindowsShellLaunchArgs
} from '../../providers/windows-shell-args'
import { resolveUnixShellPath } from '../../providers/local-pty-utils'
import { selectShellStartupFeatures } from '../../shell-startup-features'
import { parseWslPath } from '../../wsl'
import { addWslEnvKeys } from '../../wsl-env'
import {
  recognizeAgentProcessFromCommandLine,
  type RecognizedAgentProcess
} from '../../../shared/agent-process-recognition'
import { shouldUseShellReadyStartupDelivery } from '../../../shared/codex-startup-delivery'
import { ORCA_HERMES_STARTUP_QUERY_ENV } from '../../../shared/hermes-startup-query'
import { WINDOWS_GIT_BASH_SHELL } from '../../../shared/windows-terminal-shell'
import { getShellLaunchConfig, resolvePtyShellPath } from '../shell-ready'
import { resolveWslSessionContext } from '../wsl-session-context'
import { finalizeDaemonPtyEnvironment, rescrubDaemonPtyEnvironment } from './spawn-environment'
import type { PtySubprocessOptions } from '../pty-subprocess'
import { randomUUID } from 'node:crypto'
import {
  shellCommandMarkerEnv,
  SHELL_COMMAND_NONCE_ENV,
  SHELL_INTEGRATION_CONTEXT_ENV
} from '../../shell-command-marker-template'
import {
  isShellCommandMarkerInjectionEnabled,
  resolvePowerShellCommandMarkerTrust,
  scrubShellCommandMarkerPolicyEnv
} from '../../shell-integration-injection-policy'
import { release as osRelease } from 'node:os'

export type PtyShellLaunchPlan = {
  shellPath: string
  shellArgs: string[]
  spawnCwd: string
  validationCwd: string
  startupCommandDeliveredInShellArgs: boolean
  windowsFallbackAttempts: WindowsShellSpawnAttempt[]
  startupAgentRecognition: RecognizedAgentProcess | null
  shellCommandNonce: string | null
}

export function createPtyShellLaunchPlan(
  opts: PtySubprocessOptions,
  env: Record<string, string>
): PtyShellLaunchPlan {
  const resolvedWslContext = resolveWslSessionContext(opts)
  let shellPath = resolvedWslContext ? 'wsl.exe' : opts.shellOverride || resolvePtyShellPath(env)
  let shellArgs: string[]
  let startupCommandDeliveredInShellArgs = false
  let windowsFallbackAttempts: WindowsShellSpawnAttempt[] = []
  const startupAgentRecognition = recognizeAgentProcessFromCommandLine(opts.command)
  const commandNonce = randomUUID()
  let shellCommandNonce: string | null = null
  const isCodexStartupCommand = startupAgentRecognition?.agent === 'codex'
  const requestedCwd = opts.cwd || resolveSafePtyDefaultCwd()
  if (opts.command && startupAgentRecognition) {
    assertSafeAgentStartupCwd(requestedCwd, opts.command)
  }
  let spawnCwd = requestedCwd
  let validationCwd = spawnCwd

  if (process.platform === 'win32') {
    const normalizedShellFamily = pathWin32.basename(shellPath).toLowerCase()
    const resolvedGitBashPath = resolveWindowsGitBashShellPath(shellPath)
    const resolvedShellFamily: WindowsPowerShellShellFamily =
      normalizedShellFamily === 'powershell.exe' || normalizedShellFamily === 'pwsh.exe'
        ? normalizedShellFamily
        : normalizedShellFamily === 'cmd.exe' || normalizedShellFamily === 'wsl.exe'
          ? normalizedShellFamily
          : undefined
    const shouldProbePwsh = shouldProbeWindowsPowerShellAvailability({
      shellFamily: resolvedShellFamily,
      implementation: opts.terminalWindowsPowerShellImplementation
    })
    const shouldResolvePowerShellFamily =
      opts.terminalWindowsPowerShellImplementation !== undefined ||
      pathWin32.basename(shellPath) === shellPath
    if (resolvedGitBashPath) {
      shellPath = resolvedGitBashPath
    } else if (shellPath === WINDOWS_GIT_BASH_SHELL) {
      shellPath = 'powershell.exe'
    } else {
      shellPath = shouldResolvePowerShellFamily
        ? (resolveEffectiveWindowsPowerShell({
            shellFamily: resolvedShellFamily,
            implementation: opts.terminalWindowsPowerShellImplementation,
            pwshAvailable: shouldProbePwsh ? isPwshAvailable() : false
          }) ?? shellPath)
        : shellPath
    }
    if (
      pathWin32.basename(shellPath).toLowerCase() === 'cmd.exe' &&
      env.ORCA_CODEX_LAUNCH_PREFLIGHT
    ) {
      env[ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE_ENV] = '"'
    }
    windowsFallbackAttempts = buildWindowsPowerShellSpawnAttempts({
      shellPath,
      cwd: spawnCwd,
      defaultCwd: resolveSafePtyDefaultCwd(),
      wslContext: resolvedWslContext,
      startupCommand: opts.command
    })
    const primaryAttempt = windowsFallbackAttempts[0]
    if (primaryAttempt) {
      shellPath = primaryAttempt.shellPath
      shellArgs = primaryAttempt.shellArgs
      spawnCwd = primaryAttempt.effectiveCwd
      validationCwd = primaryAttempt.validationCwd
      startupCommandDeliveredInShellArgs = primaryAttempt.startupCommandDeliveredInShellArgs
    } else {
      const resolved = resolveWindowsShellLaunchArgs(
        shellPath,
        spawnCwd,
        resolveSafePtyDefaultCwd(),
        resolvedWslContext,
        opts.command,
        env.ORCA_CODEX_LAUNCH_PREFLIGHT
      )
      shellArgs = resolved.shellArgs
      spawnCwd = resolved.effectiveCwd
      validationCwd = resolved.validationCwd
      startupCommandDeliveredInShellArgs = resolved.startupCommandDeliveredInShellArgs === true
    }
    if (isWindowsGitBashShellPath(shellPath)) {
      env.CHERE_INVOKING ??= '1'
    }
    const codexHomeWslInfo = env.CODEX_HOME ? parseWslPath(env.CODEX_HOME) : null
    if (pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe') {
      if (codexHomeWslInfo) {
        const launchWslDistro = resolvedWslContext?.distro
        if (launchWslDistro && launchWslDistro !== codexHomeWslInfo.distro) {
          delete env.CODEX_HOME
          delete env.ORCA_CODEX_HOME
        } else {
          env.CODEX_HOME = codexHomeWslInfo.linuxPath
          env.ORCA_CODEX_HOME = codexHomeWslInfo.linuxPath
          addWslEnvKeys(env, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
          if (!launchWslDistro) {
            const resolved = resolveWindowsShellLaunchArgs(
              shellPath,
              requestedCwd,
              resolveSafePtyDefaultCwd(),
              { distro: codexHomeWslInfo.distro },
              opts.command,
              env.ORCA_CODEX_LAUNCH_PREFLIGHT
            )
            shellArgs = resolved.shellArgs
            spawnCwd = resolved.effectiveCwd
            validationCwd = resolved.validationCwd
            startupCommandDeliveredInShellArgs =
              resolved.startupCommandDeliveredInShellArgs === true
          }
        }
      } else if (isHostCodexHomeForWsl(env.CODEX_HOME)) {
        delete env.CODEX_HOME
        delete env.ORCA_CODEX_HOME
      } else if (env.CODEX_HOME) {
        addWslEnvKeys(env, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
      }
      if (env.CLAUDE_CONFIG_DIR) {
        addWslEnvKeys(env, ['CLAUDE_CONFIG_DIR'])
      }
      if (env[ORCA_HERMES_STARTUP_QUERY_ENV] !== undefined) {
        addWslEnvKeys(env, [ORCA_HERMES_STARTUP_QUERY_ENV])
      }
    } else if (codexHomeWslInfo || isWslCodexHomeForHost(env.CODEX_HOME)) {
      delete env.CODEX_HOME
      delete env.ORCA_CODEX_HOME
    }
    if (pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe') {
      addOrcaWslInteropEnv(env)
    }
  } else {
    rescrubDaemonPtyEnvironment(env, opts)
    const preferredShellPath = shellPath
    shellPath = resolveUnixShellPath(shellPath)
    if (shellPath !== preferredShellPath) {
      env.SHELL = shellPath
      console.warn(
        `[daemon/pty] Preferred shell "${preferredShellPath}" is unavailable, fell back to "${shellPath}"`
      )
    }
    const waitsForShellReady =
      Boolean(opts.command) &&
      (!isCodexStartupCommand ||
        shouldUseShellReadyStartupDelivery({
          command: opts.command as string,
          startupCommandDelivery: opts.startupCommandDelivery
        }))
    delete env.ORCA_SHELL_FEATURES
    delete env[SHELL_COMMAND_NONCE_ENV]
    delete env[SHELL_INTEGRATION_CONTEXT_ENV]
    const shellLaunch = getShellLaunchConfig(
      shellPath,
      selectShellStartupFeatures({
        shellPath,
        env,
        hasStartupCommand: Boolean(opts.command),
        waitsForShellReady,
        emitsStartupIdentity: waitsForShellReady,
        injectsCommandMarkers: true
      }),
      { commandNonce }
    )
    Object.assign(env, shellLaunch.env)
    if (shellLaunch.supportsCommandMarkers) {
      shellCommandNonce = commandNonce
    }
    shellArgs = shellLaunch.args ?? ['-l']
  }

  if (process.platform === 'win32') {
    delete env[SHELL_COMMAND_NONCE_ENV]
    delete env[SHELL_INTEGRATION_CONTEXT_ENV]
    const shellBasename = pathWin32.basename(shellPath).toLowerCase()
    if (shellBasename === 'wsl.exe' && isShellCommandMarkerInjectionEnabled('daemon-wsl')) {
      env.ORCA_SHELL_FEATURES = opts.command ? 'markers,ready,identity' : 'markers'
      Object.assign(env, shellCommandMarkerEnv(commandNonce))
      addOrcaWslInteropEnv(env)
      shellCommandNonce = commandNonce
    } else if (
      (shellBasename === 'pwsh.exe' || shellBasename === 'powershell.exe') &&
      isShellCommandMarkerInjectionEnabled('daemon-native')
    ) {
      shellCommandNonce = resolvePowerShellCommandMarkerTrust(process.platform, osRelease())
        ? commandNonce
        : null
      Object.assign(env, shellCommandMarkerEnv(shellCommandNonce))
    } else if (
      isWindowsGitBashShellPath(shellPath) &&
      isShellCommandMarkerInjectionEnabled('daemon-native')
    ) {
      env.ORCA_SHELL_FEATURES = 'markers'
      Object.assign(env, shellCommandMarkerEnv(commandNonce))
      shellCommandNonce = commandNonce
    }
  }
  scrubShellCommandMarkerPolicyEnv(env)

  seedPowerlevel10kWizardEnv(env, { envToDelete: opts.envToDelete })
  if (
    env[POWERLEVEL10K_WIZARD_DISABLE_ENV] !== undefined &&
    process.platform === 'win32' &&
    pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe'
  ) {
    addWslEnvKeys(env, [POWERLEVEL10K_WIZARD_DISABLE_ENV])
  }
  finalizeDaemonPtyEnvironment(env, opts.env)

  return {
    shellPath,
    shellArgs,
    spawnCwd,
    validationCwd,
    startupCommandDeliveredInShellArgs,
    windowsFallbackAttempts,
    startupAgentRecognition,
    shellCommandNonce
  }
}
