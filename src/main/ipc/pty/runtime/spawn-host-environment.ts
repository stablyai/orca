import { getAppEnvironment } from '../../../../shared/app-environment'
import { inheritOmpLaunchEnvironment } from '../host-env/omp-launch-environment'
import { buildPtyHostEnv } from '../host-env/assembly'
import { isSafePtySessionId } from '../../../daemon/pty-session-id'
import {
  shouldSkipCodexHomeEnvForWindowsShell,
  isCodexStatusHooksEnabled
} from '../host-env/codex-home'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isAgentStatusHooksEnabled } from '../../../agent-hooks/managed-agent-hook-controls'
import { stampWslOrchestrationCompatibilityHost } from '../../../pty/wsl-orca-env'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { awaitExplicitPiOmpGuestReadiness } from '../../../agent-hooks/wsl-pi-omp-guest-readiness'
import { promoteAgentTeamsShimPath } from '../host-env/path'
import type { RuntimePtySpawnState } from './spawn-state'

export async function prepareRuntimeHostSpawnEnvironment(ctx: RuntimePtySpawnState): Promise<void> {
  const args = ctx.args
  const ptySettings = ctx.deps.getSettings?.()
  if (!ctx.wslGuest && ctx.isDaemonHostSpawn && ctx.sessionId && !ctx.preAdoptedStablePane) {
    if (!isSafePtySessionId(ctx.sessionId, getAppEnvironment().getPath('userData'))) {
      throw new Error('Invalid PTY session id')
    }
    try {
      ctx.env ??= {}
      await inheritOmpLaunchEnvironment(ctx.env, {
        isWsl: shouldSkipCodexHomeEnvForWindowsShell(ctx.daemonShellOverride, ctx.cwd),
        launchAgent: args.launchAgent,
        launchCommand: ctx.launchCommand
      })
      await awaitExplicitPiOmpGuestReadiness({
        isWsl: shouldSkipCodexHomeEnvForWindowsShell(ctx.daemonShellOverride, ctx.cwd),
        distro: ctx.codexSelectionTarget.runtime === 'wsl' ? ctx.expectedWslDistro : null,
        codexHomePath: ctx.selectedCodexHomePath,
        launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined,
        launchCommand: ctx.launchCommand
      })
      ctx.env = buildPtyHostEnv(ctx.sessionId, ctx.env ?? {}, {
        isPackaged: getAppEnvironment().isPackaged(),
        resourcesPath: process.resourcesPath,
        userDataPath: getAppEnvironment().getPath('userData'),
        selectedCodexHomePath: ctx.selectedCodexHomePath,
        skipCodexHomeEnv: ctx.skipCodexHomeEnv,
        stripInheritedOrcaCodexHome: ctx.stripInheritedOrcaCodexHome,
        launchCommand: ctx.launchCommand,
        launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined,
        isWsl: shouldSkipCodexHomeEnvForWindowsShell(ctx.daemonShellOverride, ctx.cwd),
        wslDistro: ctx.codexSelectionTarget.runtime === 'wsl' ? ctx.expectedWslDistro : null,
        agentStatusHooksEnabled: isAgentStatusHooksEnabled(ptySettings),
        disabledTuiAgents: ptySettings?.disabledTuiAgents,
        codexStatusHooksEnabled: isCodexStatusHooksEnabled(ptySettings),
        networkProxySettings: ptySettings,
        routeBrowserOpensToClient: ctx.deps.runtime?.shouldRelayTerminalBrowserOpens?.(),
        deferGitConfigGuardToDaemon:
          ctx.provider.supportsGitCredentialGuardHost?.(ctx.sessionId) === true
      })
      stampWslOrchestrationCompatibilityHost(
        ctx.env,
        ctx.deps.runtime?.getOrchestrationCompatibilityHostId?.(),
        ctx.codexSelectionTarget.runtime === 'wsl' ? ctx.expectedWslDistro : null
      )
      promoteAgentTeamsShimPath(ctx.env, ctx.requestedAgentTeamsPath)
    } catch (error) {
      // Why: host-env setup can materialize agent hooks/extensions before failing.
      if (ctx.requestedSessionId === undefined) {
        clearProviderPtyState(ctx.sessionId)
      }
      throw error
    }
  }
}
