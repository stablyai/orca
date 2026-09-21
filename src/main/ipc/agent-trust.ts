import { ipcMain } from 'electron'
import { type AgentTrustPreset, markAgentWorkspaceTrusted } from '../agent-trust-presets'
import { markRemoteAgentWorkspaceTrusted } from '../remote-agent-trust-presets'

/**
 * Why: cursor-agent, GitHub Copilot CLI, and Codex gate first-launch in an
 * unfamiliar directory behind a "Do you trust this folder?" menu that consumes
 * keystrokes (numbered options / single-letter shortcuts). Orca's draft-URL
 * paste flow needs the input box, not the menu, so before Orca spawns the
 * agent it asks main to write the same trust artifacts the agents write
 * after the user accepts. Best-effort: any IO error is swallowed so a failed
 * trust write never blocks the workspace from opening.
 */
export function registerAgentTrustHandlers(): void {
  ipcMain.removeHandler('agentTrust:markTrusted')
  ipcMain.handle(
    'agentTrust:markTrusted',
    async (
      _event,
      args: { preset: AgentTrustPreset; workspacePath: string; connectionId?: string }
    ): Promise<void> => {
      if (!args || typeof args.workspacePath !== 'string' || !args.workspacePath) {
        return
      }
      try {
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId.trim() : ''
        // Why: SSH-launched agents read trust artifacts from remote host, local agents from desktop.
        await (connectionId
          ? markRemoteAgentWorkspaceTrusted({
              preset: args.preset,
              connectionId,
              workspacePath: args.workspacePath
            })
          : markAgentWorkspaceTrusted(args.preset, args.workspacePath))
      } catch {
        // Best-effort: see Why above. The user can still accept the trust
        // prompt manually if writing the artifact fails.
      }
    }
  )
}
