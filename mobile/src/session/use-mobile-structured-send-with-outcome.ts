import { selectAgentSessionCurrentRequests } from '../../../src/shared/agent-session-current-requests'
// The structured composer's one send seam: a slash command dispatches as a
// conversation command, and everything else goes out as an
// `agentSession.send` — carrying `delivery: 'queue-if-active'` only when the
// host advertises the queue and no pending prompt is one this build cannot answer.

import { useCallback } from 'react'
import { runningStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-live-turn'
import { pendingPromptsAllUnanswerableHere } from '../../../src/shared/agent-session-approval-subject'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-send-mutation'
import type { StructuredAgentSessionComposerOptions } from '../../../src/shared/structured-agent-session-composer'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { dispatchMobileStructuredCommand } from './mobile-structured-composer-command'
import type { MobileNativeChatSendErrorReporter } from './use-mobile-native-chat-send-error'
import { sendMobileStructuredAgentSessionMessage } from './mobile-structured-agent-session-send'
import type { MobileStructuredSends } from './use-mobile-structured-sends'
import { structuredSessionOperationId } from './structured-session-operation-id'
import { timeoutForDeadline } from './mobile-structured-agent-session-rpc'
import { structuredAgentSessionSendSelection } from '../../../src/shared/structured-agent-session-option-view'
import {
  actionableStructuredApproval,
  actionableStructuredQuestion
} from './mobile-structured-actionable-prompt'

/** Whether a send made now asks the host to queue it. The host's queue waits on any pending prompt;
 *  one this build cannot answer would hold the send forever, so it starts a turn instead. */
export function mobileStructuredSendQueues(
  queueCapable: boolean,
  state: Pick<StructuredAgentSessionState, 'items' | 'currentRequests'>
): boolean {
  return (
    queueCapable && !pendingPromptsAllUnanswerableHere(selectAgentSessionCurrentRequests(state))
  )
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
  /** The chat reads Stopping: a send made now is drawn after the turn being stopped. */
  stopping: boolean
  accept: MobileStructuredSends['accept']
  hold: MobileStructuredSends['hold']
  commandPending: { current: boolean }
  controller: Pick<
    StructuredAgentSessionComposerOptions,
    'snapshot' | 'setOption' | 'invokeAction' | 'conversationCommands'
  >
  onSendError: MobileNativeChatSendErrorReporter
  /** Each send carries the model and effort the picker shows; an older host takes neither. */
  carriesOptions?: boolean
}): (
  text: string,
  images?: string[],
  deadline?: number,
  attachments?: readonly StructuredMobileSendAttachment[]
) => Promise<MobileNativeChatSendOutcome> {
  const {
    accept,
    agent,
    client,
    commandPending,
    commandsWait,
    controller,
    enabled,
    hold,
    onSendError,
    queueCapable,
    carriesOptions,
    sessionId,
    stateRef,
    stopping
  } = args
  return useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[]
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
        pending: commandPending,
        controller: { agent: agent ?? undefined, ...controller },
        busy: () =>
          actionableStructuredApproval(stateRef.current) ||
          actionableStructuredQuestion(stateRef.current)
            ? 'prompt'
            : runningStructuredAgentSessionTurnId(stateRef.current)
              ? 'working'
              : null,
        // A card waiting on a prompt nothing here can answer would hold it forever.
        waitsInLine: (command) =>
          command === 'compact' &&
          commandsWait &&
          !pendingPromptsAllUnanswerableHere(selectAgentSessionCurrentRequests(stateRef.current)),
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
      // The host records it under this id, which is what settles it.
      const send = {
        clientMessageId: structuredSessionOperationId(),
        body,
        queuedAt: Date.now(),
        ...(stopping ? { sentWhileStopping: true as const } : {})
      }
      // A pick on its way holds the send, so the picker shows what the chat holds.
      const options =
        carriesOptions && agent
          ? structuredAgentSessionSendSelection(agent, controller.snapshot)
          : undefined
      const outcome = await sendMobileStructuredAgentSessionMessage({
        client,
        sessionId,
        expectedRuntimeFence: currentFence,
        text,
        attachments: sendAttachments,
        ...(mobileStructuredSendQueues(queueCapable, stateRef.current)
          ? { delivery: 'queue-if-active' as const }
          : {}),
        ...(options ? { options } : {}),
        deadline,
        clientMessageId: send.clientMessageId,
        onAccepted: (cursor) =>
          accept({ ...send, ...(cursor ? { recordedCursor: cursor } : {}) }, images),
        onError: onSendError
      })
      if (outcome === 'unknown') {
        hold(send)
      }
      return outcome
    },
    [
      accept,
      agent,
      client,
      commandPending,
      commandsWait,
      controller,
      enabled,
      hold,
      onSendError,
      queueCapable,
      carriesOptions,
      sessionId,
      stateRef,
      stopping
    ]
  )
}
