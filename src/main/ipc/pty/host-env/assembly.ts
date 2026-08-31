import { join, delimiter } from 'node:path'
import { resolveSetupAgentSequenceLaunchCommand } from '../../../../shared/setup-agent-sequencing'
import {
  detectExplicitPiAgentKindFromCommand,
  isPiCompatibleAgentType
} from '../../../../shared/pi-agent-kind'
import { applyTerminalGitCredentialPromptGuard } from '../../terminal-git-credential-guard'
import { openCodeHookService } from '../../../opencode/hook-service'
import { mimoCodeHookService } from '../../../mimo/hook-service'
import { agentHookServer } from '../../../agent-hooks/server'
import { wslHookRelayManager } from '../../../agent-hooks/wsl-hook-relay-manager'
import { piTitlebarExtensionService } from '../../../pi/titlebar-extension-service'
import { ensureLinuxTerminalOrcaCliShimDir } from '../../../cli/linux-terminal-orca-cli-shim'
import { stripLegacyTerminalShimEnv } from '../../../pty/legacy-terminal-shim-dir'
import { resolvePathEnvKey, mergePersistedWindowsPath } from '../../../pty/windows-environment-path'
import { resolveCodexShellLaunchPreflightCommand } from '../../../pty/codex-shell-launch-preflight'
import { buildConfiguredProxyEnv } from '../../../../shared/network-proxy'
import type { BuildPtyHostEnvOptions } from './types'
import { readInheritedPath } from './path'
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

  // Why: local path's baseEnv includes process.env but the daemon path doesn't (fork inheritance, not IPC); check both sources so guards stay in lock-step across spawn paths.
  const preexistingOpenCodeConfigDir = resolveOpenCodeSourceConfigDir(baseEnv)
  const launchCommandHint = resolveSetupAgentSequenceLaunchCommand(baseEnv, opts.launchCommand)
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

  if (opts.agentStatusHooksEnabled) {
    // Why: OPENCODE_CONFIG_DIR is a single path, not a colon-list; mirror the user's value into an overlay so their plugins and Orca's status plugin coexist. See docs/opencode-config-dir-collision.md.
    Object.assign(baseEnv, openCodeHookService.buildPtyEnv(id, preexistingOpenCodeConfigDir))
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
      primary: 'OPENCODE_CONFIG_DIR',
      overlay: 'ORCA_OPENCODE_CONFIG_DIR',
      source: 'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
    })
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
      wslHookRelayManager.ensureForDistro(distro, opts.selectedCodexHomePath)
      const guestEndpoint = wslHookRelayManager.getGuestEndpointFilePath(distro)
      if (guestEndpoint) {
        baseEnv.ORCA_AGENT_HOOK_ENDPOINT = guestEndpoint
      }
      // Why: OpenCode loads its status plugin from a guest config overlay, so point OPENCODE_CONFIG_DIR at the guest dir the relay materialized.
      const opencodeOverlayDir = wslHookRelayManager.getOpenCodeOverlayDir(distro)
      if (opencodeOverlayDir) {
        baseEnv.OPENCODE_CONFIG_DIR = opencodeOverlayDir
        baseEnv.ORCA_OPENCODE_CONFIG_DIR = opencodeOverlayDir
        delete baseEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR
      } else {
        // Why: relay not connected yet (or older guest bundle) — never cross the Windows overlay path into WSL; drop it so in-guest OpenCode uses its own config (pre-fix behavior, no status but no regression).
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
    // Why: bare shells historically defaulted to Pi + OMP shadow prep and
    // created ~/.<agent>/agent even when the user never launches those agents
    // (#10196). Only create default homes on an explicit Pi/OMP launch;
    // otherwise install only into an existing agent dir (or userData for OMP
    // status so a typed `omp` still gets the shell wrapper extension).
    if (piAgentKind === 'pi') {
      const piEnv = piTitlebarExtensionService.buildPtyEnv(id, preexistingPiAgentDir, 'pi', {
        materializeDefaultHome: explicitPiAgentKind === 'pi'
      })
      Object.assign(baseEnv, piEnv)
      exposePiManagedExtensionEnv(baseEnv, 'pi', piEnv)
    }

    if (shouldPrepareOmpShadow) {
      const ompEnv = piTitlebarExtensionService.buildPtyEnv(id, preexistingOmpAgentDir, 'omp', {
        materializeDefaultHome: explicitPiAgentKind === 'omp'
      })
      Object.assign(baseEnv, ompEnv)
      exposePiManagedExtensionEnv(baseEnv, 'omp', ompEnv)
    }

    if (piAgentKind === 'prime-agent' && !opts.isWsl) {
      const primeEnv = piTitlebarExtensionService.buildPtyEnv(
        id,
        preexistingPrimeAgentDir,
        'prime-agent',
        { materializeDefaultHome: explicitPiAgentKind === 'prime-agent' }
      )
      Object.assign(baseEnv, primeEnv)
      exposePiManagedExtensionEnv(baseEnv, 'prime-agent', primeEnv)
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
    delete baseEnv.ORCA_OMP_STATUS_EXTENSION
    // Why: prompt submission waits for OMP's composer-ready OSC marker even
    // when status hooks are disabled. Reinstall only that profile-owned
    // sentinel for explicit OMP and bare shells; non-OMP launches retain the
    // hooks-disabled contract and receive no OMP extension.
    if (shouldPrepareOmpShadow) {
      Object.assign(baseEnv, piTitlebarExtensionService.buildOmpPromptReadinessEnv())
    }
    delete baseEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR
    delete baseEnv.ORCA_PRIME_AGENT_STATUS_EXTENSION
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
      hooksEnabled: opts.codexStatusHooksEnabled ?? opts.agentStatusHooksEnabled,
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

  // Why: WSL shells need the managed userData root for shell-ready wrappers; dev-mode terminals need the same export so `orca` targets the live dev instance.
  if (opts.isWsl) {
    baseEnv.ORCA_USER_DATA_PATH = opts.userDataPath
    // Why: managed WSL registration uses `orca-ide`; exposing that literal scopes agent guidance to WSL without a bare-orca shim.
    baseEnv.ORCA_CLI_COMMAND = opts.isPackaged ? 'orca-ide' : 'orca-dev'
  } else {
    if (!opts.isPackaged) {
      baseEnv.ORCA_USER_DATA_PATH ??= opts.userDataPath
    }
    delete baseEnv.ORCA_CLI_COMMAND
  }
  // Why: dev mode needs the launcher PATH override so `orca` resolves to the dev build instead of the production binary at /usr/local/bin/orca.
  if (!opts.isPackaged) {
    const devCliBin = join(opts.userDataPath, 'cli', 'bin')
    const inheritedPath = readInheritedPath(baseEnv)
    // Why: an empty PATH segment resolves as `.` in some shells (commands run from cwd); avoid a trailing delimiter.
    baseEnv[resolvePathEnvKey(baseEnv, process.platform)] = inheritedPath
      ? `${devCliBin}${delimiter}${inheritedPath}`
      : devCliBin
  } else if (process.platform === 'linux') {
    // Why: bare-`orca` shim scoped to Orca PTYs — Linux CLI installs as `orca-ide` to avoid shadowing GNOME's /usr/bin/orca screen reader (stablyai/orca#7904).
    const shimDir = ensureLinuxTerminalOrcaCliShimDir({ userDataPath: opts.userDataPath })
    if (shimDir) {
      const inheritedEntries = readInheritedPath(baseEnv)
        .split(delimiter)
        .filter((entry) => entry.length > 0 && entry !== shimDir)
      baseEnv.PATH = [shimDir, ...inheritedEntries].join(delimiter)
    }
  } else if (
    opts.resourcesPath &&
    (process.platform === 'darwin' || process.platform === 'win32')
  ) {
    // Why: global CLI registration is optional, but agents in Orca-managed PTYs must always reach this app's bundled CLI.
    const bundledCliBin = join(opts.resourcesPath, 'bin')
    const inheritedPath = readInheritedPath(baseEnv)
    baseEnv[resolvePathEnvKey(baseEnv, process.platform)] = inheritedPath
      ? `${bundledCliBin}${delimiter}${inheritedPath}`
      : bundledCliBin
  }

  if (
    opts.routeBrowserOpensToClient === true &&
    baseEnv.BROWSER === undefined &&
    process.env.BROWSER === undefined
  ) {
    const cliCommand = opts.isWsl ? (opts.isPackaged ? 'orca-ide' : 'orca-dev') : 'orca'
    baseEnv.BROWSER = `${cliCommand} open-url --url %s`
  }

  // Why: must run after the prepends above — they re-read PATH from the unscrubbed
  // process.env when baseEnv carries none, which is the daemon path's normal shape.
  stripLegacyTerminalShimEnv(baseEnv, process.platform)

  return baseEnv
}
