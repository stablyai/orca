import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import { copyChatReadMarksToConversationKeys } from '../../../shared/agent-session/view/chat-read-mark-copy'

/** Once per profile, before any window or paired client reads it: the host's saved chat read marks
 *  gain their conversation keys (chat-read-mark-copy.ts). The flag is set even when nothing copies,
 *  so a later Mark unread on the conversation key is never undone by a second copy. */
export function copyChatReadMarksAtLoad(state: PersistedState): {
  state: PersistedState
  changed: boolean
} {
  if (state.ui._chatReadMarksCopiedToConversationKeys === true) {
    return { state, changed: false }
  }
  const sessions = [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})]
  const tabs = sessions.flatMap((session) => Object.values(session?.unifiedTabs ?? {}).flat())
  const copied = copyChatReadMarksToConversationKeys(
    {
      acknowledgedAgentsByPaneKey: state.ui.acknowledgedAgentsByPaneKey ?? {},
      activityClearedAtByPaneKey: state.ui.activityClearedAtByPaneKey ?? {},
      manuallyUnreadTurnsByPaneKey: state.ui.manuallyUnreadTurnsByPaneKey ?? {}
    },
    tabs
  )
  return {
    state: {
      ...state,
      ui: { ...state.ui, ...copied, _chatReadMarksCopiedToConversationKeys: true }
    },
    changed: true
  }
}

/** Load normalization plus the one-time copy, so a copy that changed the profile saves with it. */
export function withChatReadMarksCopied<T extends { state: PersistedState; changed: boolean }>(
  normalized: T
): T {
  const copied = copyChatReadMarksAtLoad(normalized.state)
  return { ...normalized, state: copied.state, changed: normalized.changed || copied.changed }
}
