// The structured composer's one send seam: a slash command dispatches as a
// conversation command, and everything else goes out as an
// `agentSession.send` — carrying `delivery: 'queue-if-active'` only when the
// host advertises the queue and no pending prompt is one this build cannot answer.

import { useCallback } from 'react'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'
import { runningStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-live-turn'
import { pendingPromptsAllUnanswerableHere } from '../../../src/shared/agent-session-approval-subject'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-send-mutation'
import type { StructuredAgentSessionComposerOptions } from '../../../src/shared/structured-agent-session-composer'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import { dispatchMobileStructuredCommand } from './mobile-structured-composer-command'
import {
  MOBILE_STRUCTURED_SEND_NOT_SENT,
  sendMobileStructuredAgentSessionMessage,
  type MobileStructuredSendResult
} from './mobile-structured-agent-session-send'
import type { MobileNativeChatSendErrorReporter } from './use-mobile-native-chat-send-error'
import { timeoutForDeadline } from './mobile-structured-agent-session-rpc'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion
} from './mobile-structured-agent-prompts'

/** Whether a send made now asks the host to queue it. The host's queue waits on any pending prompt;
 *  one this build cannot answer would hold the send forever, so it starts a turn instead. */
export function mobileStructuredSendQueues(
  queueCapable: boolean,
  items: StructuredAgentSessionState['items']
): boolean {
  return queueCapable && !pendingPromptsAllUnanswerableHere(items)
}

export type StructuredMobileSendAttachment = StructuredAgentSessionAttachment & {
  id?: string
}

export function useMobileStructuredSendWithOutcome(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  queueCapable: boolean
  /** The host holds a /compact sent while the agent works as a card. */
  commandsWait: boolean
  stateRef: { readonly current: StructuredAgentSessionState }
  commandPending: { current: boolean }
  controller: Pick<
    StructuredAgentSessionComposerOptions,
    'snapshot' | 'setOption' | 'invokeAction' | 'conversationCommands'
  >
  onSendError: MobileNativeChatSendErrorReporter
}): (
  text: string,
  images?: string[],
  deadline?: number,
  attachments?: readonly StructuredMobileSendAttachment[]
) => Promise<MobileStructuredSendResult> {
  const {
    agent,
    client,
    commandPending,
    commandsWait,
    controller,
    enabled,
    onSendError,
    queueCapable,
    sessionId,
    stateRef
  } = args
  return useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[]
    ): Promise<MobileStructuredSendResult> => {
      const currentFence = stateRef.current.fence
      if (!client || !sessionId || !enabled || currentFence === null) {
        onSendError('Message not sent (disconnected)')
        return MOBILE_STRUCTURED_SEND_NOT_SENT
      }
      const timeoutMs = timeoutForDeadline(deadline)
      if (timeoutMs === null) {
        onSendError('Message not sent')
        return MOBILE_STRUCTURED_SEND_NOT_SENT
      }
      if (attachments === undefined && images !== undefined && images.length > 0) {
        onSendError('Message not sent')
        return MOBILE_STRUCTURED_SEND_NOT_SENT
      }
      const sendAttachments = attachments ?? []
      const commandOutcome = await dispatchMobileStructuredCommand({
        text,
        agentName: agent ? (tuiAgentDisplayName(agent) ?? agent) : undefined,
        hasAttachments: Boolean(sendAttachments.length || images?.length),
        client,
        sessionId,
        fence: currentFence,
        pending: commandPending,
        controller: {
          agent: agent === 'claude' ? 'claude' : 'codex',
          ...controller
        },
        busy: () =>
          stateRef.current.items.some(
            (item) => pendingStructuredApproval(item) || pendingStructuredQuestion(item)
          )
            ? 'prompt'
            : runningStructuredAgentSessionTurnId(stateRef.current)
              ? 'working'
              : null,
        // A card waiting on a prompt nothing here can answer would hold it forever.
        waitsInLine: (command) =>
          command === 'compact' &&
          commandsWait &&
          !pendingPromptsAllUnanswerableHere(stateRef.current.items),
        onError: onSendError,
        timeoutMs
      })
      if (commandOutcome !== null) {
        return { outcome: commandOutcome, clientMessageId: null }
      }
      const body = structuredAgentSessionSendBody(text, sendAttachments)
      if (body.blocks.length === 0) {
        return MOBILE_STRUCTURED_SEND_NOT_SENT
      }
      return sendMobileStructuredAgentSessionMessage({
        client,
        sessionId,
        expectedRuntimeFence: currentFence,
        text,
        attachments: sendAttachments,
        ...(mobileStructuredSendQueues(queueCapable, stateRef.current.items)
          ? { delivery: 'queue-if-active' as const }
          : {}),
        deadline,
        onError: onSendError
      })
    },
    [
      agent,
      client,
      commandPending,
      commandsWait,
      controller,
      enabled,
      onSendError,
      queueCapable,
      sessionId,
      stateRef
    ]
  )
}
