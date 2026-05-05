import { ipcMain } from 'electron'
import { markCopilotFolderTrusted, markCursorWorkspaceTrusted } from '../agent-trust-presets'

export type AgentTrustPreset = 'cursor' | 'copilot'

/**
 * Why: cursor-agent and GitHub Copilot CLI gate first-launch in an unfamiliar
 * directory behind a "Do you trust this folder?" menu that consumes
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
    async (_event, args: { preset: AgentTrustPreset; workspacePath: string }): Promise<void> => {
      if (!args || typeof args.workspacePath !== 'string' || !args.workspacePath) {
        return
      }
      try {
        if (args.preset === 'cursor') {
          markCursorWorkspaceTrusted(args.workspacePath)
        } else if (args.preset === 'copilot') {
          markCopilotFolderTrusted(args.workspacePath)
        }
      } catch {
        // Best-effort: see Why above. The user can still accept the trust
        // prompt manually if writing the artifact fails.
      }
    }
  )
}
