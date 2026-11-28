import {
  CHAT_READ_MARK_FIELDS,
  indexLegacyChatReadMarks,
  moveChatReadMark,
  recordCanonicalChatReadMarkMatches,
  recordChatReadMarkMatch,
  type ChatReadMarkMatches,
  type ChatReadMarks
} from '../../../shared/agent-session/view/chat-read-mark-move'
import {
  capPaneKeyTimestampRecord,
  readPaneKeyTimestampRecord
} from '../../../shared/agent-session/view/pane-key-timestamp-record'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'

export function moveChatReadMarksAtLoad(state: PersistedState): PersistedState {
  const index = indexLegacyChatReadMarks(state.ui)
  if (index.size === 0) {
    return state
  }

  const matches: ChatReadMarkMatches = new Map()
  recordCanonicalChatReadMarkMatches(index, matches, state.ui)
  const sessions = [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})]
  for (const session of sessions) {
    for (const tabs of Object.values(session?.unifiedTabs ?? {})) {
      for (const tab of tabs) {
        if (tab.contentType === 'agent-session') {
          recordChatReadMarkMatch(index, matches, tab.entityId)
        }
      }
    }
  }

  const moved: Partial<ChatReadMarks> = {}
  let changed = false
  for (const field of CHAT_READ_MARK_FIELDS) {
    const source = state.ui[field]
    let record: Record<string, number> | undefined
    for (const [leaf, key] of matches) {
      const aliases = index.get(leaf)?.[field]
      if (key && aliases && source) {
        record ??= readPaneKeyTimestampRecord(source)
        changed = moveChatReadMark(record, key, aliases) || changed
      }
    }
    if (record) {
      moved[field] = record
    }
  }
  if (!changed) {
    return state
  }
  const ui = { ...state.ui }
  for (const field of CHAT_READ_MARK_FIELDS) {
    ui[field] = capPaneKeyTimestampRecord(moved[field] ?? readPaneKeyTimestampRecord(ui[field]))
  }
  return { ...state, ui }
}
