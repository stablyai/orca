import { resolveSetupAgentSequenceLaunchCommand } from '../../../../shared/setup-agent-sequencing'
import { selectOpenCodeHookAgent } from '../../../../shared/opencode-launch-command'
import {
  detectExplicitPiAgentKindFromCommand,
  isPiCompatibleAgentType
} from '../../../../shared/pi-agent-kind'
import { applyTerminalGitCredentialPromptGuard } from '../../terminal-git-credential-guard'
import { openCode2HookService, openCodeHookService } from '../../../opencode/hook-service'
import {
  OPENCODE_CONFIG_DIR_ENV_KEYS,
  isOpenCodeLegacySharedConfigDir
} from '../../../opencode/legacy-shared-config-dir'
import { mimoCodeHookService } from '../../../mimo/hook-service'
import { agentHookServer } from '../../../agent-hooks/server'
import { wslHookRelayManager } from '../../../agent-hooks/wsl-hook-relay-manager'
import { piTitlebarExtensionService } from '../../../pi/titlebar-extension-service'
import { prependOrcaCliDirToChildPath } from '../../../cli/orca-cli-child-path'
import { getManagedWslCliDir, getWslCliCommandName } from '../../../cli/wsl-managed-cli'
import { stripLegacyTerminalShimEnv } from '../../../pty/legacy-terminal-shim-dir'
import { mergePersistedWindowsPath } from '../../../pty/windows-environment-path'
import { resolveCodexShellLaunchPreflightCommand } from '../../../pty/codex-shell-launch-preflight'
import { buildConfiguredProxyEnv } from '../../../../shared/network-proxy'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { BuildPtyHostEnvOptions } from './types'
import { stripInheritedOrcaCodexHomeOverride } from './codex-home'
import {
  clearPiAgentShadowEnv,
  exposePiManagedExtensionEnv,
  isMimoLaunchCommand,
  resolveMimocodeSourceHome,
  resolveOpenCodeSourceConfigDir,
  resolvePiAgentSourceDir,
  resolveScopedPiAgentSourceDir,
  restoreOrStripOverlayEnv
} from './pi-agent'
import { AGENT_HOOK_RUNTIME_ENV_KEYS } from './spawn-env-keys'

/**
 * Mutates `baseEnv` in place with all host-local PTY env vars and returns it.
 *
 * Do NOT call when `args.connectionId` is set (SSH): every injection is host-loopback
 * or references local filesystem paths meaningless to a remote shell.
 */
export function buildPtyHostEnv(
  id: string,
  baseEnv: Record<string, string>,
  opts: BuildPtyHostEnvOptions
): Record<string, string> {
  mergePersistedWindowsPath(baseEnv)
  Object.assign(baseEnv, buildConfiguredProxyEnv(opts.networkProxySettings))

  // Why: pre-1.4.209 panes exported Orca's retired shared hooks dir; inheriting it hides the user's global OpenCode config.
  const isLegacyOpenCodeHooksDir = (dir: string | undefined): boolean =>
    isOpenCodeLegacySharedConfigDir(dir, opts.userDataPath)
  const inheritedOpenCodeEnv: NodeJS.ProcessEnv = {}
  for (const key of OPENCODE_CONFIG_DIR_ENV_KEYS) {
    if (isLegacyOpenCodeHooksDir(baseEnv[key])) {
      delete baseEnv[key]
    }
    if (!isLegacyOpenCodeHooksDir(process.env[key])) {
      inheritedOpenCodeEnv[key] = process.env[key]
    }
  }
  // A daemon or sibling shell can retain a retired path that main no longer sees.
  openCodeHookService.refreshLegacySharedPlugin()
  openCode2HookService.refreshLegacySharedPlugin()
  const resolvedOpenCodeConfigDir = resolveOpenCodeSourceConfigDir(baseEnv, inheritedOpenCodeEnv)
  const preexistingOpenCodeConfigDir = isLegacyOpenCodeHooksDir(resolvedOpenCodeConfigDir)
    ? undefined
    : resolvedOpenCodeConfigDir
  const launchCommandHint = resolveSetupAgentSequenceLaunchCommand(baseEnv, opts.launchCommand)
  const openCodeAgent = selectOpenCodeHookAgent(
    opts.launchAgent,
    launchCommandHint,
    (agent) => opts.agentStatusHooksEnabled && isTuiAgentEnabled(agent, opts.disabledTuiAgents)
  )
  const explicitPiAgentKind = isPiCompatibleAgentType(opts.launchAgent)
    ? opts.launchAgent
    : opts.launchAgent === undefined
      ? detectExplicitPiAgentKindFromCommand(launchCommandHint)
      : null
  const piAgentKind = explicitPiAgentKind ?? 'pi'
  const hasLaunchCommand =
    typeof launchCommandHint === 'string' && launchCommandHint.trim().length > 0

  // Why: unattended agents must fail instead of looping on OS credential prompts; user terminals keep normal Git behavior.
  applyTerminalGitCredentialPromptGuard(baseEnv, {
    launchCommand: launchCommandHint,
    isUnattended: opts.launchAgent !== undefined,
    deferGitConfigGuardToHost: opts.deferGitConfigGuardToDaemon
  })

  const shouldPrepareOmpShadow = piAgentKind === 'omp' || !hasLaunchCommand
  const shouldInstallPiExtensions =
    opts.agentStatusHooksEnabled && isTuiAgentEnabled('pi', opts.disabledTuiAgents)
  const shouldInstallOmpExtensions =
    opts.agentStatusHooksEnabled && isTuiAgentEnabled('omp', opts.disabledTuiAgents)
  const shouldInstallPrimeAgentExtensions =
    opts.agentStatusHooksEnabled && isTuiAgentEnabled('prime-agent', opts.disabledTuiAgents)
  const shouldInstallOmoExtensions =
    opts.agentStatusHooksEnabled && isTuiAgentEnabled('omo', opts.disabledTuiAgents)
  // Why: source shadows are agent-scoped; trusting the other kind's source reintroduces Pi/OMP extension-state shadowing.
  const preexistingPiAgentDir = resolvePiAgentSourceDir(baseEnv, 'pi')
  const preexistingOmpAgentDir =
    piAgentKind === 'omp'
      ? resolvePiAgentSourceDir(baseEnv, 'omp')
      : resolveScopedPiAgentSourceDir(baseEnv, 'omp')
  const preexistingPrimeAgentDir =
    piAgentKind === 'prime-agent'
      ? resolvePiAgentSourceDir(baseEnv, 'prime-agent')
      : resolveScopedPiAgentSourceDir(baseEnv, 'prime-agent')
  const preexistingOmoAgentDir =
    piAgentKind === 'omo'
      ? resolvePiAgentSourceDir(baseEnv, 'omo')
      : resolveScopedPiAgentSourceDir(baseEnv, 'omo')

  restoreOrStripOverlayEnv(
    baseEnv,
    {
      primary: 'OPENCODE_CONFIG_DIR',
      overlay: 'ORCA_OPENCODE_CONFIG_DIR',
      source: 'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
      preserveExplicitPrimary: true
    },
    inheritedOpenCodeEnv
  )
  delete baseEnv.ORCA_OPENCODE_AGENT
  if (openCodeAgent) {
    // Why: OPENCODE_CONFIG_DIR is a single path, not a colon-list; mirror the user's value into an overlay so their plugins and Orca's status plugin coexist. See docs/opencode-config-dir-collision.md.
    const openCodeStatusService =
      openCodeAgent === 'opencode2' ? openCode2HookService : openCodeHookService
    baseEnv.ORCA_OPENCODE_AGENT = openCodeAgent
    // WSL owns its config writes; only the guest overlay may enter a WSL pane.
    if (!opts.isWsl) {
      Object.assign(baseEnv, openCodeStatusService.buildPtyEnv(id, preexistingOpenCodeConfigDir))
    }
    if (baseEnv.OPENCODE_CONFIG_DIR) {
      // Why: ~/.zshrc can re-export the user's default after spawn; shell-ready wrappers restore this PTY-scoped value.
      baseEnv.ORCA_OPENCODE_CONFIG_DIR = baseEnv.OPENCODE_CONFIG_DIR
      if (preexistingOpenCodeConfigDir) {
        // Why: nested Orca terminals inherit the overlay as OPENCODE_CONFIG_DIR; keep the real source so overlays don't mirror overlays.
        baseEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR = preexistingOpenCodeConfigDir
      } else {
        delete baseEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR
      }
    }
  }
  if (opts.agentStatusHooksEnabled) {
    if (isMimoLaunchCommand(launchCommandHint)) {
      const preexistingMimocodeHome = resolveMimocodeSourceHome(baseEnv)
      Object.assign(baseEnv, mimoCodeHookService.buildPtyEnv(id, preexistingMimocodeHome))
      if (baseEnv.MIMOCODE_HOME) {
        baseEnv.ORCA_MIMOCODE_HOME = baseEnv.MIMOCODE_HOME
        if (preexistingMimocodeHome) {
          baseEnv.ORCA_MIMOCODE_SOURCE_HOME = preexistingMimocodeHome
        } else {
          delete baseEnv.ORCA_MIMOCODE_SOURCE_HOME
        }
      }
    }
  } else {
    restoreOrStripOverlayEnv(baseEnv, {
      primary: 'MIMOCODE_HOME',
      overlay: 'ORCA_MIMOCODE_HOME',
      source: 'ORCA_MIMOCODE_SOURCE_HOME'
    })
  }

  // Why: strip inherited hook coordinates before injecting this PTY's fresh loopback receiver, so nested-terminal callbacks route to the owning pane.
  for (const key of AGENT_HOOK_RUNTIME_ENV_KEYS) {
    delete baseEnv[key]
  }
  if (opts.agentStatusHooksEnabled) {
    Object.assign(baseEnv, agentHookServer.buildPtyEnv())
    if (opts.isWsl === true) {
      // Why: hook POSTs to 127.0.0.1 die inside WSL's NAT namespace; use the guest-resident relay's endpoint instead of the Windows one.
      const distro = opts.wslDistro ?? null
      const wslLaunchKind =
        explicitPiAgentKind === 'pi' || explicitPiAgentKind === 'omp'
          ? explicitPiAgentKind
          : undefined
      wslHookRelayManager.ensureForDistro(distro, opts.selectedCodexHomePath, wslLaunchKind)
      const guestEndpoint = wslHookRelayManager.getGuestEndpointFilePath(distro)
      if (guestEndpoint) {
        baseEnv.ORCA_AGENT_HOOK_ENDPOINT = guestEndpoint
      }
      // Why: OpenCode loads its status plugin from a guest config overlay, so point OPENCODE_CONFIG_DIR at the guest dir the relay materialized.
      const opencodeOverlayDir = openCodeAgent
        ? wslHookRelayManager.getOpenCodeOverlayDir(distro, openCodeAgent)
        : null
      if (opencodeOverlayDir) {
        baseEnv.OPENCODE_CONFIG_DIR = opencodeOverlayDir
        baseEnv.ORCA_OPENCODE_CONFIG_DIR = opencodeOverlayDir
        delete baseEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR
      } else {
        // Only guest overlays belong in WSL; otherwise let OpenCode use its guest config.
        delete baseEnv.OPENCODE_CONFIG_DIR
        delete baseEnv.ORCA_OPENCODE_CONFIG_DIR
        delete baseEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR
      }
    }
  }

  // Why: PI_CODING_AGENT_DIR is the user's config/session root; install only Orca-owned extension files, don't override it.
  if (opts.agentStatusHooksEnabled) {
    clearPiAgentShadowEnv(baseEnv, 'pi')
    clearPiAgentShadowEnv(baseEnv, 'omp')
    clearPiAgentShadowEnv(baseEnv, 'prime-agent')
    clearPiAgentShadowEnv(baseEnv, 'omo')
    // Why: bare shells historically defaulted to Pi + OMP shadow prep and
    // created ~/.<agent>/agent even when the user never launches those agents
    // (#10196). Only create default homes on an explicit Pi/OMP launch;
    // otherwise install only into an existing agent dir (or userData for OMP
    // status so a typed `omp` still gets the shell wrapper extension).
    if (shouldInstallPiExtensions && piAgentKind === 'pi') {
      const piEnv = piTitlebarExtensionService.buildPtyEnv(id, preexistingPiAgentDir, 'pi', {
        materializeDefaultHome: explicitPiAgentKind === 'pi'
      })
      Object.assign(baseEnv, piEnv)
      exposePiManagedExtensionEnv(baseEnv, 'pi', piEnv)
    }

    if (shouldInstallOmpExtensions && shouldPrepareOmpShadow) {
      const ompEnv = piTitlebarExtensionService.buildPtyEnv(id, preexistingOmpAgentDir, 'omp', {
        materializeDefaultHome: explicitPiAgentKind === 'omp',
        // WSL loads the host-rooted managed extension through drvfs; guest storage stays separate.
        ...(opts.isWsl
          ? { configDirName: '.omp' }
          : baseEnv.PI_CONFIG_DIR !== undefined
            ? { configDirName: baseEnv.PI_CONFIG_DIR }
            : {})
      })
      Object.assign(baseEnv, ompEnv)
      exposePiManagedExtensionEnv(baseEnv, 'omp', ompEnv)
    } else if (shouldPrepareOmpShadow) {
      // Keep guarded OMP launches supplied with a fresh config even when its
      // managed status extension is disabled.
      Object.assign(baseEnv, piTitlebarExtensionService.buildFreshOmpEnv())
    }

    if (shouldInstallPrimeAgentExtensions && piAgentKind === 'prime-agent' && !opts.isWsl) {
      const primeEnv = piTitlebarExtensionService.buildPtyEnv(
        id,
        preexistingPrimeAgentDir,
        'prime-agent',
        { materializeDefaultHome: explicitPiAgentKind === 'prime-agent' }
      )
      Object.assign(baseEnv, primeEnv)
      exposePiManagedExtensionEnv(baseEnv, 'prime-agent', primeEnv)
    }

    if (shouldInstallOmoExtensions && piAgentKind === 'omo' && !opts.isWsl) {
      const omoEnv = piTitlebarExtensionService.buildPtyEnv(id, preexistingOmoAgentDir, 'omo', {
        materializeDefaultHome: explicitPiAgentKind === 'omo'
      })
      Object.assign(baseEnv, omoEnv)
      exposePiManagedExtensionEnv(baseEnv, 'omo', omoEnv)
    }
  } else {
    // Why: nested PTYs must not inherit stale source or overlay state from another agent.
    restoreOrStripOverlayEnv(baseEnv, {
      primary: 'PI_CODING_AGENT_DIR',
      overlay: 'ORCA_PI_CODING_AGENT_DIR',
      source: 'ORCA_PI_SOURCE_AGENT_DIR'
    })
    restoreOrStripOverlayEnv(baseEnv, {
      primary: 'PI_CODING_AGENT_DIR',
      overlay: 'ORCA_OMP_CODING_AGENT_DIR',
      source: 'ORCA_OMP_SOURCE_AGENT_DIR'
    })
    if (shouldPrepareOmpShadow) {
      Object.assign(baseEnv, piTitlebarExtensionService.buildFreshOmpEnv())
    }
    delete baseEnv.ORCA_OMP_STATUS_EXTENSION
    delete baseEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR
    delete baseEnv.ORCA_PRIME_AGENT_STATUS_EXTENSION
    delete baseEnv.ORCA_OMO_SOURCE_AGENT_DIR
    delete baseEnv.ORCA_OMO_STATUS_EXTENSION
  }

  if (opts.isWsl && opts.agentStatusHooksEnabled) {
    const distro = opts.wslDistro ?? null
    if (explicitPiAgentKind === 'pi') {
      const guestPiDir = wslHookRelayManager.getGuestAgentPath(distro, 'pi')
      if (guestPiDir) {
        baseEnv.ORCA_PI_SOURCE_AGENT_DIR = guestPiDir
      }
    } else if (explicitPiAgentKind === 'omp') {
      const guestOmpExtension = wslHookRelayManager.getGuestAgentPath(distro, 'omp')
      if (guestOmpExtension) {
        baseEnv.ORCA_OMP_STATUS_EXTENSION = guestOmpExtension
      }
    }
  }

  // Why: keep the Codex home override PTY-scoped so dev/prod Orcas don't share hooks through ~/.codex.
  if (opts.skipCodexHomeEnv) {
    delete baseEnv.CODEX_HOME
    delete baseEnv.ORCA_CODEX_HOME
    delete baseEnv.ORCA_CODEX_LAUNCH_PREFLIGHT
  } else if (opts.selectedCodexHomePath) {
    baseEnv.CODEX_HOME = opts.selectedCodexHomePath
    // Why: user startup files may re-export CODEX_HOME; shell-ready wrappers restore this runtime home before Codex launches.
    baseEnv.ORCA_CODEX_HOME = opts.selectedCodexHomePath
    const preflightCommand = resolveCodexShellLaunchPreflightCommand({
      hooksEnabled:
        opts.agentStatusHooksEnabled && isTuiAgentEnabled('codex', opts.disabledTuiAgents),
      isPackaged: opts.isPackaged,
      isWsl: opts.isWsl,
      managedHomePath: opts.selectedCodexHomePath,
      userDataPath: opts.userDataPath,
      resourcesPath: opts.resourcesPath
    })
    if (preflightCommand) {
      baseEnv.ORCA_CODEX_LAUNCH_PREFLIGHT = preflightCommand
    } else {
      delete baseEnv.ORCA_CODEX_LAUNCH_PREFLIGHT
    }
  } else if (opts.stripInheritedOrcaCodexHome) {
    stripInheritedOrcaCodexHomeOverride(baseEnv)
    delete baseEnv.ORCA_CODEX_LAUNCH_PREFLIGHT
  } else {
    delete baseEnv.ORCA_CODEX_LAUNCH_PREFLIGHT
  }

  // Why: an inherited copy (e.g. Orca launched from a WSL pane) names another launch's CLI.
  delete baseEnv.ORCA_WSL_CLI_DIR
  // Why: WSL shells need the managed userData root for shell-ready wrappers; dev-mode terminals need the same export so `orca` targets the live dev instance.
  if (opts.isWsl) {
    baseEnv.ORCA_USER_DATA_PATH = opts.userDataPath
    // Why: managed WSL registration uses `orca-ide`; exposing that literal scopes agent guidance to WSL without a bare-orca shim.
    baseEnv.ORCA_CLI_COMMAND = getWslCliCommandName(opts.isPackaged)
    const managedCliDir = getManagedWslCliDir(opts)
    if (managedCliDir) {
      baseEnv.ORCA_WSL_CLI_DIR = managedCliDir
    }
  } else {
    if (!opts.isPackaged) {
      baseEnv.ORCA_USER_DATA_PATH ??= opts.userDataPath
    }
    delete baseEnv.ORCA_CLI_COMMAND
  }
  prependOrcaCliDirToChildPath(baseEnv, {
    isPackaged: opts.isPackaged,
    userDataPath: opts.userDataPath,
    resourcesPath: opts.resourcesPath
  })

  if (
    opts.routeBrowserOpensToClient === true &&
    baseEnv.BROWSER === undefined &&
    process.env.BROWSER === undefined
  ) {
    const cliCommand = opts.isWsl ? getWslCliCommandName(opts.isPackaged) : 'orca'
    baseEnv.BROWSER = `${cliCommand} open-url --url %s`
  }

  // Why: must run after the prepends above — they re-read PATH from the unscrubbed
  // process.env when baseEnv carries none, which is the daemon path's normal shape.
  stripLegacyTerminalShimEnv(baseEnv, process.platform)

  return baseEnv
}
