import { ipcMain } from 'electron'
import {
  detectRemoteWindowsTerminalCapabilities,
  runPreflightCheck
} from '../preflight/agent-detection'
import { detectAgentsOnHost, refreshAgentsOnHost } from '../preflight/workspace-agent-detection'
import type {
  PreflightRuntimeContext,
  PreflightStatus,
  RemoteWindowsTerminalCapabilities
} from '../preflight/agent-detection'

// Why this file is thin: everything above the handler layer moved to
// ../preflight/agent-detection so the runtime can call it without ipcMain.
// Re-exported here so existing importers of `ipc/preflight` keep working.
export * from '../preflight/agent-detection'
import { readZCodeInteractiveCapability } from '../zcode/interactive-capability'

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
    detectAgentsOnHost({ kind: 'local', context: args })
  )

  // Why here: this is the one place that already answers "what can the installed agent CLIs
  // do", and the probe is cached, so a repeat launch costs nothing.
  ipcMain.handle('preflight:zcodeInteractiveCapability', async () =>
    readZCodeInteractiveCapability()
  )

  ipcMain.handle('preflight:refreshAgents', async (_event, args?: PreflightRuntimeContext) => {
    return refreshAgentsOnHost({ kind: 'local', context: args })
  })

  ipcMain.handle(
    'preflight:detectRemoteAgents',
    async (_event, args: { connectionId: string }): Promise<string[]> =>
      detectAgentsOnHost({ kind: 'ssh', connectionId: args.connectionId })
  )

  ipcMain.handle(
    'preflight:detectRemoteWindowsTerminalCapabilities',
    async (_event, args: { connectionId: string }): Promise<RemoteWindowsTerminalCapabilities> => {
      return detectRemoteWindowsTerminalCapabilities(args)
    }
  )
}
