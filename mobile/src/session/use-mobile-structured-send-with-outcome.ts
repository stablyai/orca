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
import { sendMobileStructuredAgentSessionMessage } from './mobile-structured-agent-session-send'
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
  contentFingerprint?: string
}

export function useMobileStructuredSendWithOutcome(args: {
  agent: string | null
  callerIdentity: string
  client: RpcClient | null
  sessionId: string | null
  sessionKey: string
  enabled: boolean
  queueCapable: boolean
  stateRef: { readonly current: StructuredAgentSessionState }
  commandPending: { current: boolean }
  controller: Pick<
    StructuredAgentSessionComposerOptions,
    'snapshot' | 'setOption' | 'invokeAction' | 'conversationCommands'
  >
  onSendError: (message: string) => void
}): (
  text: string,
  images?: string[],
  deadline?: number,
  attachments?: readonly StructuredMobileSendAttachment[]
) => Promise<MobileNativeChatSendOutcome> {
  const {
    agent,
    callerIdentity,
    client,
    commandPending,
    controller,
    enabled,
    onSendError,
    queueCapable,
    sessionId,
    sessionKey,
    stateRef
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
        controller: {
          agent: agent === 'claude' ? 'claude' : 'codex',
          ...controller
        },
        canRun: () =>
          !runningStructuredAgentSessionTurnId(stateRef.current) &&
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
        sessionKey,
        callerIdentity,
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
      callerIdentity,
      client,
      commandPending,
      controller,
      enabled,
      onSendError,
      queueCapable,
      sessionId,
      sessionKey,
      stateRef
    ]
  )
}
