import { useCallback, useMemo, useState } from 'react'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import {
  mergeNativeChatLiveSession,
  nativeChatHookHasWorkingSubagents,
  resolveNativeChatHookState
} from '../../../src/shared/native-chat/native-chat-live-status'
import { shouldClearNativeChatWorkingSuppression } from '../../../src/shared/native-chat/native-chat-working-suppression'
import {
  nativeChatHookLatestTurnWorkedSeconds,
  nativeChatHookTurnStartedAt,
  nativeChatLatestTurnId,
  nativeChatTerminalSettledTurns,
  nativeChatTranscriptSettledTurns,
  resolveNativeChatTerminalTurn,
  type NativeChatTerminalTurn
} from '../../../src/shared/native-chat/native-chat-terminal-turn'
import { deriveNativeChatStreamingText } from '../../../src/shared/native-chat/native-chat-streaming'
import { useThrottledLatestValue } from './use-throttled-latest-value'
import type { MobileNativeChatSession } from './use-mobile-native-chat-session'
import type { MobileNativeChatResolution } from './native-chat/mobile-native-chat-eligibility'

const NO_MESSAGES: NativeChatMessage[] = []

export type MobileNativeChatTerminalTurn = NativeChatTerminalTurn & {
  streamingText: string | undefined
  workingStartedAt: number | null
  settledTurns: NativeChatSettledTurns
  /** Stop hides working until the turn ends or a newer working epoch starts. */
  stop: () => void
}

// Desktop's terminal-chat turn rules (NativeChatResolvedView) over the phone's hook row and transcript feed.
export function useMobileNativeChatTerminalTurn(args: {
  /** The terminal chat's hook row; null for structured chats or when no chat shows. */
  status: AgentStatusEntry | null | undefined
  resolution: Pick<MobileNativeChatResolution, 'agent' | 'sessionId'> | null
  /** The terminal chat's transcript; null for structured chats. */
  session: Pick<MobileNativeChatSession, 'messages' | 'transcriptLifecycle'> | null
  /** The newest pending echo; a new one is a new send, which ends Stop's suppression like desktop. */
  latestPendingId: string | null
  hasPromptCard: boolean
  scopeKey: string
  stop: () => Promise<boolean>
}): MobileNativeChatTerminalTurn {
  const { status, resolution, latestPendingId, hasPromptCard, scopeKey, stop } = args
  const hasPending = latestPendingId !== null
  const messages = args.session?.messages ?? NO_MESSAGES
  const transcriptLifecycle = args.session?.transcriptLifecycle
  const hookState = resolveNativeChatHookState(status)
  const stateStartedAt = status?.stateStartedAt ?? null
  const live = mergeNativeChatLiveSession({
    messages,
    sessionId: resolution?.sessionId ?? null,
    agent: resolution?.agent ?? '',
    hookState,
    stateStartedAt,
    transcriptLifecycle,
    hookHasWorkingSubagents: nativeChatHookHasWorkingSubagents(status)
  })
  const liveWorking = live.status === 'working'
  // Throttle status-part previews to avoid reparsing the whole accumulated markdown per part.
  const streamingText = useThrottledLatestValue(
    deriveNativeChatStreamingText({
      // A pending echo is the transcript's tail on desktop, so no earlier reply can hide the preview.
      messages: hasPending ? NO_MESSAGES : messages,
      previewText: status?.lastAssistantMessage,
      working: liveWorking,
      previewIsToolOutput: status?.lastAssistantMessageIsToolOutput === true
    }) ?? undefined,
    50
  )

  // The working epoch a Stop suppressed; a newer epoch, a new send or the turn's end releases it.
  const [suppression, setSuppression] = useState<{
    scopeKey: string
    epoch: number | null
    latestPendingId: string | null
  } | null>(null)
  const suppressed = suppression?.scopeKey === scopeKey ? suppression : null
  const sentSince = hasPending && latestPendingId !== suppressed?.latestPendingId
  if (
    suppressed &&
    (sentSince ||
      shouldClearNativeChatWorkingSuppression({
        working: liveWorking,
        interrupted: true,
        workingEpoch: stateStartedAt,
        previousWorkingEpoch: suppressed.epoch
      }))
  ) {
    setSuppression(null)
  } else if (suppressed && suppressed.epoch === null && stateStartedAt !== null) {
    setSuppression({ ...suppressed, epoch: stateStartedAt })
  }
  const interrupted = suppressed !== null
  const stopTurn = useCallback(() => {
    const pressed = { scopeKey, epoch: stateStartedAt, latestPendingId }
    setSuppression(pressed)
    void stop().then((sent) => {
      if (!sent) {
        setSuppression((current) => (current === pressed ? null : current))
      }
    })
  }, [latestPendingId, scopeKey, stateStartedAt, stop])

  const turn = resolveNativeChatTerminalTurn({
    isConversation: messages.length > 0 || hasPending || streamingText !== undefined,
    working: liveWorking,
    hookAwaitingInput: live.hookAwaitingInput,
    interrupted,
    hasPromptCard
  })

  const turnStartedAt = nativeChatHookTurnStartedAt(status ?? undefined)
  const latestWorkedSeconds = nativeChatHookLatestTurnWorkedSeconds(
    status ?? undefined,
    hookState === null
  )
  const transcriptSettled = useMemo(() => nativeChatTranscriptSettledTurns(messages), [messages])
  const latestTurnId = useMemo(() => nativeChatLatestTurnId(messages), [messages])
  const settledTurns = useMemo(
    () =>
      nativeChatTerminalSettledTurns({
        transcriptSettled,
        latestTurnId,
        latestWorkedSeconds,
        turnStartedAt,
        turnActive: turn.turnActive
      }),
    [latestTurnId, latestWorkedSeconds, transcriptSettled, turn.turnActive, turnStartedAt]
  )
  return {
    ...turn,
    streamingText,
    workingStartedAt: turn.turnActive ? turnStartedAt : null,
    settledTurns,
    stop: stopTurn
  }
}
