import { getAppEnvironment } from '../../../../shared/app-environment'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { prepareWslGuestTerminalSpawn } from '../../../wsl/wsl-guest-terminal-preparation'
import { isAgentStatusHooksEnabled } from '../../../agent-hooks/managed-agent-hook-controls'
import { isCodexStatusHooksEnabled } from '../host-env/codex-home'
import { stampWslOrchestrationCompatibilityHost } from '../../../pty/wsl-orca-env'
import type { RuntimePtySpawnState } from './spawn-state'

export async function prepareRuntimeGuestSpawnOptions(ctx: RuntimePtySpawnState): Promise<void> {
  if (!ctx.wslGuest) {
    return
  }
  if (!ctx.wslGuest.fresh && !ctx.wslGuest.coldRestore) {
    ctx.spawnOptions.attachOnly = true
    return
  }
  if (ctx.wslGuest.coldRestore) {
    ctx.spawnOptions.sessionId = ctx.effectiveSessionAppId
    ctx.spawnOptions.isNewSession = false
    ctx.spawnOptions.attachOnly = false
  }
  const settings = ctx.deps.getSettings?.()
  const environment = getAppEnvironment()
  ctx.spawnOptions = await prepareWslGuestTerminalSpawn(
    ctx.wslGuest.prepared,
    ctx.spawnOptions,
    {
      isPackaged: environment.isPackaged(),
      resourcesPath: process.resourcesPath,
      userDataPath: environment.getPath('userData'),
      selectedCodexHomePath: ctx.selectedCodexHomePath,
      skipCodexHomeEnv: ctx.skipCodexHomeEnv,
      stripInheritedOrcaCodexHome: ctx.stripInheritedOrcaCodexHome,
      launchCommand: ctx.launchCommand,
      launchAgent: isTuiAgent(ctx.args.launchAgent) ? ctx.args.launchAgent : undefined,
      agentStatusHooksEnabled: isAgentStatusHooksEnabled(settings),
      disabledTuiAgents: settings?.disabledTuiAgents,
      codexStatusHooksEnabled: isCodexStatusHooksEnabled(settings),
      networkProxySettings: settings,
      routeBrowserOpensToClient: ctx.deps.runtime?.shouldRelayTerminalBrowserOpens?.(),
      deferGitConfigGuardToDaemon: true
    },
    ctx.args.signal,
    ctx.wslGuest.coldRestore ? 'confirmed-exited' : undefined
  )
  ctx.env = ctx.spawnOptions.env
  if (ctx.env) {
    stampWslOrchestrationCompatibilityHost(
      ctx.env,
      ctx.deps.runtime?.getOrchestrationCompatibilityHostId?.(),
      ctx.expectedWslDistro
    )
  }
}
