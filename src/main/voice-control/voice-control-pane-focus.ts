import { parsePaneKey } from '../../shared/stable-pane-id'
import type { VoiceRosterEntry } from './voice-control-roster'

/**
 * Builds the renderer messages that focus one agent's pane, reusing the notification
 * click-through path (`ui:activateWorktree` then `ui:focusTerminal` by stable leaf id).
 * Pure: the caller owns the webContents send. Null when the pane key doesn't parse.
 */
export function buildAgentPaneFocusMessages(
  entry: VoiceRosterEntry
): { channel: string; payload: Record<string, unknown> }[] | null {
  const target = parsePaneKey(entry.paneKey)
  if (!target) {
    return null
  }
  return [
    {
      channel: 'ui:activateWorktree',
      payload: { repoId: entry.repoId, worktreeId: entry.worktreeId }
    },
    {
      channel: 'ui:focusTerminal',
      payload: {
        tabId: target.tabId,
        worktreeId: entry.worktreeId,
        leafId: target.leafId,
        ackPaneKeyOnSuccess: entry.paneKey,
        flashFocusedPane: true,
        scrollToBottomIfOutputSinceLastView: true
      }
    }
  ]
}
