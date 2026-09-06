import { ipcMain } from 'electron'
import {
  detectInstalledAgentsWithShellPathHydration,
  detectRemoteAgents,
  detectRemoteWindowsTerminalCapabilities,
  refreshShellPathAndDetectAgents,
  runPreflightCheck
} from '../preflight/agent-detection'
import type {
  PreflightRuntimeContext,
  PreflightStatus,
  RemoteWindowsTerminalCapabilities
} from '../preflight/agent-detection'
import type { AgentHealthProvider, AgentUpdateResult } from '../../shared/agent-health'
import { probeAgentHealth, probeAgentProviderHealth, updateAgent } from './agent-health-probe'

// Why this file is thin: everything above the handler layer moved to
// ../preflight/agent-detection so the runtime can call it without ipcMain.
// Re-exported here so existing importers of `ipc/preflight` keep working.
export * from '../preflight/agent-detection'

function parseAgentHealthProvider(args: unknown): AgentHealthProvider {
  const provider =
    typeof args === 'object' && args !== null && 'provider' in args ? args.provider : undefined
  if (provider === 'claude' || provider === 'codex') {
    return provider
  }
  throw new TypeError('Unsupported agent health provider')
}

export function registerPreflightHandlers(): void {
  ipcMain.handle(
    'preflight:check',
    async (
      _event,
      args?: PreflightRuntimeContext & { force?: boolean }
    ): Promise<PreflightStatus> => {
      return runPreflightCheck(args?.force, args)
    }
  )

  ipcMain.handle('preflight:detectAgents', async (_event, args?: PreflightRuntimeContext) =>
    detectInstalledAgentsWithShellPathHydration(args)
  )

  ipcMain.handle('preflight:refreshAgents', async (_event, args?: PreflightRuntimeContext) => {
    return refreshShellPathAndDetectAgents(args)
  })

  ipcMain.handle('preflight:probeAgentHealth', async (_event, args?: PreflightRuntimeContext) => {
    return probeAgentHealth(args)
  })

  ipcMain.handle('preflight:probeAgentHealthProvider', async (_event, args: unknown) =>
    probeAgentProviderHealth(
      parseAgentHealthProvider(args),
      args as PreflightRuntimeContext | undefined
    )
  )

  ipcMain.handle(
    'preflight:updateAgent',
    async (_event, args: unknown): Promise<AgentUpdateResult> =>
      updateAgent(parseAgentHealthProvider(args), args as PreflightRuntimeContext | undefined)
  )

  // Why: remote worktrees need agent detection on the SSH host, not the local
  // machine. This handler forwards the same KNOWN_AGENT_COMMANDS list to the
  // relay's preflight.detectAgents RPC, whose lookup command is selected on
  // the remote host so native Windows OpenSSH does not require a POSIX shell.
  ipcMain.handle(
    'preflight:detectRemoteAgents',
    async (_event, args: { connectionId: string }): Promise<string[]> => {
      return detectRemoteAgents(args)
    }
  )

  ipcMain.handle(
    'preflight:detectRemoteWindowsTerminalCapabilities',
    async (_event, args: { connectionId: string }): Promise<RemoteWindowsTerminalCapabilities> => {
      return detectRemoteWindowsTerminalCapabilities(args)
    }
  )
}
