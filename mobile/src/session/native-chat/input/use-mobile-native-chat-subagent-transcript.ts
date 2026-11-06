import { useCallback, useMemo, useState } from 'react'
import { agentJournalItemSubagentId } from '../../../../../src/shared/agent-session/journal/agent-session-journal-producer'
import {
  nativeChatSubagentActivities,
  type NativeChatSubagentActivity
} from '../../../../../src/shared/native-chat/input/native-chat-activity'
import { projectNativeChatTranscript } from '../../../../../src/shared/native-chat/transcript/native-chat-transcript-projection'
import { frameNativeChatSubagentTranscript } from '../../../../../src/shared/native-chat/input/native-chat-subagent-brief'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatAgentMessages,
  type MobileNativeChatPendingItem
} from '../mobile-native-chat-render-data'
import type { OlderPagePhase } from '../../use-mobile-older-page-loader'
import {
  useMobileNativeChatSubagentPage,
  type MobileNativeChatSubagentRead
} from './use-mobile-native-chat-subagent-page'

type SubagentHistory = {
  hasMore: boolean | undefined
  olderPages: OlderPagePhase
  loadEarlier: (() => void) | undefined
}

/** The open subagent transcript, or the main conversation when none is focused. */
export function useMobileNativeChatSubagentTranscript({
  messages,
  folded,
  streaming,
  pending,
  imagePreviewsByMessageId,
  mainHistory,
  agent,
  sendSurfaceId,
  subagentSeed = null,
  readSubagentPage = null
}: {
  messages: readonly NativeChatMessage[]
  folded: NativeChatMessage[]
  streaming: string | null
  pending: MobileNativeChatPendingItem[]
  imagePreviewsByMessageId: Record<string, string[]> | undefined
  mainHistory: SubagentHistory
  agent: string | null | undefined
  sendSurfaceId: string
  subagentSeed?: readonly NativeChatSubagentActivity[] | null
  readSubagentPage?: MobileNativeChatSubagentRead | null
}): {
  shownFolded: NativeChatMessage[]
  shownStreaming: string | null
  shownPending: MobileNativeChatPendingItem[]
  data: ReturnType<typeof buildMobileNativeChatTransientData>['data']
  scopeKey: string
  focusedId: string | null
  rowSource: readonly NativeChatMessage[]
  /** Props for the activity bar. */
  activityBar: {
    subagents: readonly NativeChatSubagentActivity[]
    focused: NativeChatSubagentActivity | null
    focusedTranscriptEmpty: boolean
    onFocusSubagent: (agentId: string | null) => void
  }
  onFocusSubagent: (agentId: string | null) => void
  history: SubagentHistory
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
  // Keep a roster entry focused before its rows arrive, and while a replacement leaves the roster unsettled.
  if (requestedId && !focused && subagentSeed != null) {
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
    const childPage = readSubagentPage
      ? (page.messages ?? [])
      : messages.filter((message) => agentJournalItemSubagentId(message) === focusedId)
    return frameNativeChatSubagentTranscript(
      focusedId,
      childPage,
      projection.conversation,
      focused ? { title: focused.label, prompt: null } : undefined,
      !readSubagentPage || page.messages != null
    )
  }, [focused, focusedId, messages, page.messages, projection.conversation, readSubagentPage])
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
  const shownStreaming = focusedId ? null : streaming
  const shownPending = focusedId ? [] : pending
  const { data } = useMemo(
    () =>
      buildMobileNativeChatTransientData({
        folded: shownFolded,
        streaming: shownStreaming,
        pending: shownPending,
        imagePreviewsByMessageId: focusedId ? undefined : imagePreviewsByMessageId
      }),
    [focusedId, imagePreviewsByMessageId, shownFolded, shownPending, shownStreaming]
  )
  return {
    data,
    scopeKey: focusedId ? `${sendSurfaceId}\0${focusedId}` : sendSurfaceId,
    shownFolded,
    shownStreaming,
    shownPending,
    focusedId,
    rowSource,
    activityBar: {
      subagents,
      focused,
      focusedTranscriptEmpty:
        focusedId != null && !page.loading && (childFolded?.length ?? 0) === 0,
      onFocusSubagent
    },
    onFocusSubagent,
    history:
      readSubagentPage && focusedId
        ? {
            hasMore: page.hasMore && !page.loading,
            olderPages: page.olderPages,
            loadEarlier: page.loadEarlier
          }
        : mainHistory
  }
}
