import { useCallback, useMemo, useState } from 'react'
import { agentJournalItemSubagentId } from '../../../../../src/shared/agent-session-journal-producer'
import {
  latestNativeChatTaskList,
  nativeChatSubagentActivities,
  type NativeChatSubagentActivity
} from '../../../../../src/shared/native-chat/input/native-chat-activity'
import type { NativeChatTaskList } from '../../../../../src/shared/native-chat/input/native-chat-task-list'
import { projectNativeChatTranscript } from '../../../../../src/shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  foldMobileNativeChatAgentMessages,
  type MobileNativeChatPendingItem
} from '../../mobile-native-chat-render-data'

/** The open subagent transcript, or the main conversation when none is focused. */
export function useMobileNativeChatSubagentTranscript({
  messages,
  folded,
  streaming,
  pending,
  agent,
  sendSurfaceId
}: {
  messages: readonly NativeChatMessage[]
  folded: NativeChatMessage[]
  streaming: string | null
  pending: MobileNativeChatPendingItem[]
  agent: string | null | undefined
  sendSurfaceId: string
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
} {
  const projection = useMemo(() => projectNativeChatTranscript(messages), [messages])
  const subagents = useMemo(
    () => nativeChatSubagentActivities(projection.conversation, projection.subagentRows),
    [projection]
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
  const rowSource = useMemo(
    () =>
      focusedId
        ? messages.filter((message) => agentJournalItemSubagentId(message) === focusedId)
        : messages,
    [focusedId, messages]
  )
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
  const taskList = useMemo(() => latestNativeChatTaskList(shownFolded), [shownFolded])
  return {
    shownFolded,
    shownStreaming: focusedId ? null : streaming,
    shownPending: focusedId ? [] : pending,
    focusedId,
    rowSource,
    taskList,
    subagents,
    focused,
    focusedTranscriptEmpty: focusedId != null && (childFolded?.length ?? 0) === 0,
    onFocusSubagent
  }
}
