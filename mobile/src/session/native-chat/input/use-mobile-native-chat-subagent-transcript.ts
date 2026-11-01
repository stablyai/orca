import { useCallback, useMemo, useState } from 'react'
import { agentJournalItemSubagentId } from '../../../../../src/shared/agent-session/journal/agent-session-journal-producer'
import {
  nativeChatSubagentActivities,
  nativeChatVisibleTaskList,
  type NativeChatSubagentActivity
} from '../../../../../src/shared/native-chat/input/native-chat-activity'
import type { NativeChatTaskList } from '../../../../../src/shared/native-chat/input/native-chat-task-list'
import type { NativeChatTaskSeedList } from '../../../../../src/shared/native-chat/input/native-chat-claude-task-updates'
import { projectNativeChatTranscript } from '../../../../../src/shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  foldMobileNativeChatAgentMessages,
  type MobileNativeChatPendingItem
} from '../../mobile-native-chat-render-data'
import type { OlderPagePhase } from '../../use-mobile-older-page-loader'
import {
  useMobileNativeChatSubagentPage,
  type MobileNativeChatSubagentRead
} from './use-mobile-native-chat-subagent-page'

/** The open subagent transcript, or the main conversation when none is focused. */
export function useMobileNativeChatSubagentTranscript({
  messages,
  folded,
  streaming,
  pending,
  agent,
  sendSurfaceId,
  taskList: sessionTaskList = null,
  subagentSeed = null,
  readSubagentPage = null
}: {
  messages: readonly NativeChatMessage[]
  folded: NativeChatMessage[]
  streaming: string | null
  pending: MobileNativeChatPendingItem[]
  agent: string | null | undefined
  sendSurfaceId: string
  taskList?: NativeChatTaskSeedList | null
  subagentSeed?: readonly NativeChatSubagentActivity[] | null
  readSubagentPage?: MobileNativeChatSubagentRead | null
}): {
  shownFolded: NativeChatMessage[]
  shownStreaming: string | null
  shownPending: MobileNativeChatPendingItem[]
  focusedId: string | null
  rowSource: readonly NativeChatMessage[]
  taskList: NativeChatTaskList | null
  subagents: readonly NativeChatSubagentActivity[]
  focused: NativeChatSubagentActivity | null
  focusedTranscriptEmpty: boolean
  onFocusSubagent: (agentId: string | null) => void
  childHistory: {
    hasMore: boolean
    olderPages: OlderPagePhase
    loadEarlier: () => void
  } | null
} {
  const projection = useMemo(() => projectNativeChatTranscript(messages), [messages])
  const subagents = useMemo(
    () =>
      nativeChatSubagentActivities(projection.conversation, projection.subagentRows, subagentSeed),
    [projection, subagentSeed]
  )
  const [focus, setFocus] = useState<{ surfaceId: string; agentId: string | null }>({
    surfaceId: sendSurfaceId,
    agentId: null
  })
  if (focus.surfaceId !== sendSurfaceId) {
    setFocus({ surfaceId: sendSurfaceId, agentId: null })
  }
  const requestedId = focus.surfaceId === sendSurfaceId ? focus.agentId : null
  const focused = subagents.find((entry) => entry.id === requestedId) ?? null
  // Keep a roster entry focused before its rows arrive. Clear it only once the roster drops it.
  if (requestedId && !focused) {
    setFocus({ surfaceId: sendSurfaceId, agentId: null })
  }
  const focusedId = focused?.id ?? null
  const page = useMobileNativeChatSubagentPage(
    readSubagentPage ? focusedId : null,
    readSubagentPage
  )
  const rowSource = useMemo(() => {
    if (!focusedId) {
      return messages
    }
    if (readSubagentPage) {
      return page.messages ?? []
    }
    return messages.filter((message) => agentJournalItemSubagentId(message) === focusedId)
  }, [focusedId, messages, page.messages, readSubagentPage])
  const childFolded = useMemo(() => {
    if (!focusedId) {
      return null
    }
    return foldMobileNativeChatAgentMessages(rowSource, agent ?? '')
  }, [agent, focusedId, rowSource])
  const shownFolded = focusedId ? (childFolded ?? []) : folded
  const onFocusSubagent = useCallback(
    (agentId: string | null) => setFocus({ surfaceId: sendSurfaceId, agentId }),
    [sendSurfaceId]
  )
  const taskList = useMemo(
    () =>
      nativeChatVisibleTaskList(
        focusedId ? folded : shownFolded,
        focusedId ? shownFolded : null,
        sessionTaskList
      ),
    [focusedId, folded, sessionTaskList, shownFolded]
  )
  return {
    shownFolded,
    shownStreaming: focusedId ? null : streaming,
    shownPending: focusedId ? [] : pending,
    focusedId,
    rowSource,
    taskList,
    subagents,
    focused,
    focusedTranscriptEmpty: focusedId != null && !page.loading && (childFolded?.length ?? 0) === 0,
    onFocusSubagent,
    childHistory:
      readSubagentPage && focusedId
        ? {
            hasMore: page.hasMore && !page.loading,
            olderPages: page.olderPages,
            loadEarlier: page.loadEarlier
          }
        : null
  }
}
