import { useCallback, useMemo, useRef } from 'react'
import { dispatchMobileStructuredCommand } from './mobile-structured-composer-command'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-outbox'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { isStructuredAgentSessionMainAgentWorking } from '../../../src/shared/structured-agent-session-main-agent-working'
import {
  activeStructuredAgentSessionTurnId,
  isStructuredAgentSessionThinking
} from '../../../src/shared/structured-agent-session-live-turn'
import { selectStructuredAgentTurnActivity } from '../../../src/shared/native-chat-turn-activity'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion,
  projectStructuredPermission,
  projectStructuredQuestion
} from './mobile-structured-agent-prompts'
import {
  requestStructuredAgentSessionMutation,
  timeoutForDeadline,
  type StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSession } from './use-mobile-native-chat-session'
import type { NativeChatLiveTurnIndicator } from '../../../src/shared/native-chat-turn-status'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'
import { useMobileStructuredPromptResponses } from './use-mobile-structured-prompt-responses'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'
import { sendMobileStructuredAgentSessionMessage } from './mobile-structured-agent-session-send'
import { useMobileStructuredSendOperationReconciliation } from './use-mobile-structured-send-operation-reconciliation'
import {
  pendingStructuredPromptIdentity,
  requestMobileStructuredAgentSessionCancel
} from './mobile-structured-agent-session-cancel'

type StructuredMobileAttachment = StructuredAgentSessionAttachment & { id?: string }

type StructuredMobileSession = ReturnType<typeof useMobileStructuredAgentOptions> &
  ReturnType<typeof useMobileStructuredAgentTurnTiming> & {
    session: MobileNativeChatSession
    isWorking: boolean
    turnId: string | null
    /** What labels the live turn's one indicator row. */
    turnIndicator: NativeChatLiveTurnIndicator
    sendWithOutcome: (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileAttachment[]
    ) => Promise<MobileNativeChatSendOutcome>
    cancel: () => void
    permission: MobileChatPermission | null
    question: MobileChatQuestion | null
    respondPermission: (optionId: string) => Promise<boolean>
    respondQuestion: (answer: string) => Promise<boolean>
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
  }

export function useMobileStructuredAgentSession(args: {
  client: RpcClient | null
  sessionId: string | null
  /** Host/workspace scope used to keep same provider ids isolated. */
  sourceIdentity?: string
  enabled: boolean
  /** Live transport only; gates the connection-scoped hold, nothing else. */
  connected: boolean
  /** Capability facts from the shared runtime status probe; null follows the legacy wire. */
  hostSupport: StructuredAgentSessionHostSupport | null
  agent: string | null
  onSendError: (message: string) => void
}): StructuredMobileSession {
  const {
    agent,
    client,
    connected,
    sessionId,
    sourceIdentity = '',
    enabled,
    onSendError,
    hostSupport
  } = args
  const promptCancelSupported = hostSupport?.promptCancel ?? null
  const sessionKey = encodeNativeChatTranscriptIdentity([sourceIdentity, agent, sessionId])
  const commandPendingRef = useRef(false)
  // A Stop of the turn one is already stopping joins it.
  const inFlightStopsRef = useRef(new Map<string, Promise<boolean>>())
  const stateArgs = { client, sessionId, sessionKey, enabled, connected }
  const { state, stateRef, loadingOlder, loadEarlier } = useMobileStructuredAgentState(stateArgs)
  useMobileStructuredSendOperationReconciliation(state.submissions)

  const mutate = useCallback(
    async <TValue>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>
    ): Promise<StructuredAgentSessionMutationResult<TValue>> => {
      const current = stateRef.current
      if (!client || !sessionId || !enabled || current.fence === null) {
        return { status: 'rejected' }
      }
      const targetFence = current.fence
      const result = await requestStructuredAgentSessionMutation<TValue>({
        client,
        method,
        fingerprintMethod,
        sessionId,
        expectedRuntimeFence: targetFence,
        fields
      })
      if (result.status === 'accepted') {
        return {
          status: 'accepted',
          value: result.value,
          sameFence: stateRef.current.fence === targetFence
        }
      }
      if (result.status === 'unknown') {
        return result
      }
      onSendError(result.message)
      return { status: 'rejected' }
    },
    [client, enabled, onSendError, sessionId]
  )

  const options = useMobileStructuredAgentOptions({
    agent,
    client,
    sessionId,
    enabled,
    fence: state.fence,
    mutate
  })
  const { conversationCommands, invokeStructuredOption, optionSnapshot, setStructuredOption } =
    options

  const sendWithOutcome = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileAttachment[]
    ): Promise<MobileNativeChatSendOutcome> => {
      const currentFence = stateRef.current.fence
      if (!client || !sessionId || !enabled || currentFence === null) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      const timeoutMs = timeoutForDeadline(deadline)
      if (timeoutMs === null) {
        onSendError('Message not sent')
        return 'rejected'
      }
      if (attachments === undefined && images !== undefined && images.length > 0) {
        onSendError('Message not sent')
        return 'rejected'
      }
      const sendAttachments = attachments ?? []
      const commandOutcome = await dispatchMobileStructuredCommand({
        text,
        hasAttachments: Boolean(sendAttachments.length || images?.length),
        client,
        sessionId,
        fence: currentFence,
        pending: commandPendingRef,
        controller: {
          agent: agent === 'claude' ? 'claude' : 'codex',
          snapshot: optionSnapshot,
          setOption: setStructuredOption,
          invokeAction: invokeStructuredOption,
          conversationCommands
        },
        canRun: () =>
          !activeStructuredAgentSessionTurnId(stateRef.current.items) &&
          !stateRef.current.items.some(
            (item) => pendingStructuredApproval(item) || pendingStructuredQuestion(item)
          ),
        onError: onSendError,
        timeoutMs
      })
      if (commandOutcome !== null) {
        return commandOutcome
      }
      const body = structuredAgentSessionSendBody(text, sendAttachments)
      if (body.blocks.length === 0) {
        return 'rejected'
      }
      return sendMobileStructuredAgentSessionMessage({
        client,
        sessionId,
        expectedRuntimeFence: currentFence,
        body,
        deadline,
        onError: onSendError
      })
    },
    [
      agent,
      client,
      conversationCommands,
      enabled,
      invokeStructuredOption,
      onSendError,
      optionSnapshot,
      sessionId,
      setStructuredOption
    ]
  )
  const { groupedDraft, respondPermission, respondQuestion } = useMobileStructuredPromptResponses({
    stateRef,
    sessionKey,
    mutate,
    questionAnswersSupported: hostSupport?.questionAnswers ?? null,
    onSendError
  })

  const requestCancel = useCallback(
    (prompt?: { itemId: string; expectedRevision: number }): Promise<boolean> =>
      requestMobileStructuredAgentSessionCancel({
        client,
        enabled,
        inFlight: inFlightStopsRef.current,
        onSendError,
        prompt,
        promptCancelSupported,
        sessionId,
        stateRef
      }),
    [client, enabled, onSendError, promptCancelSupported, sessionId, stateRef]
  )

  const messages = useMemo(
    () => projectStructuredAgentSessionMessages(state.items, [], state.submissions),
    [state.items, state.submissions]
  )
  const turnId = activeStructuredAgentSessionTurnId(state.items)
  const turnTiming = useMobileStructuredAgentTurnTiming(state, turnId)
  const activityText =
    selectStructuredAgentTurnActivity(state.items, turnId, state.activity)?.text ?? null
  const thinking = isStructuredAgentSessionThinking(state.items)
  const turnIndicator = useMemo(() => ({ thinking, activityText }), [thinking, activityText])
  const status = state.status === 'idle' ? 'idle' : state.status
  const approvalPrompt = useMemo(
    () => state.items.find(pendingStructuredApproval) ?? null,
    [state.items]
  )
  const questionPrompt = useMemo(
    () => state.items.find(pendingStructuredQuestion) ?? null,
    [state.items]
  )
  return {
    ...options,
    session: {
      messages,
      status,
      transcriptLoading: status === 'loading',
      error: state.error,
      hasMore: state.hasOlder,
      loadingEarlier: loadingOlder,
      loadEarlier
    },
    isWorking: isStructuredAgentSessionMainAgentWorking(turnId, state.submissions, state.fence),
    turnId,
    turnIndicator,
    ...turnTiming,
    sendWithOutcome,
    cancel: () => {
      void requestCancel()
    },
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) =>
      requestCancel(prompt ?? pendingStructuredPromptIdentity(stateRef.current.items)),
    permission: projectStructuredPermission(approvalPrompt),
    question: projectStructuredQuestion(questionPrompt, groupedDraft),
    respondPermission,
    respondQuestion
  }
}
