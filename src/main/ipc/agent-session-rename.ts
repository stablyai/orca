import { ipcMain } from 'electron'
import {
  readAgentSessionRenamedTitle,
  type AgentSessionRenamedTitleArgs
} from '../agent-session-rename-title-read'

/**
 * Why: Claude publishes a deliberate `/rename` and its auto-generated summaries
 * on one OSC title channel, so the renderer cannot tell them apart from the live
 * title. It asks main to check the session transcript, which records the rename
 * as `custom-title`, and stores the answer on the tab.
 */
export function registerAgentSessionRenameHandlers(): void {
  ipcMain.removeHandler('agentSession:getRenamedTitle')
  ipcMain.handle(
    'agentSession:getRenamedTitle',
    async (_event, args?: AgentSessionRenamedTitleArgs): Promise<string | null> => {
      if (!args || typeof args.transcriptPath !== 'string') {
        return null
      }
      return readAgentSessionRenamedTitle({
        transcriptPath: args.transcriptPath,
        ...(typeof args.connectionId === 'string' ? { connectionId: args.connectionId } : {})
      })
    }
  )
}
