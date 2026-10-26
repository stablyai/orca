import { selectAgentSessionCurrentRequests } from '../../../src/shared/agent-session-current-requests'

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
import { nativeChatTextWithFileReferences } from './native-chat/composer/mobile-native-chat-file-attachment'
import {
  actionableStructuredApproval,
  actionableStructuredQuestion
} from './mobile-structured-actionable-prompt'

// An unsupported pending prompt would hold queued sends forever; start a turn instead.
export function mobileStructuredSendQueues(
  queueCapable: boolean,
  state: Pick<StructuredAgentSessionState, 'items' | 'currentRequests'>
): boolean {
  return (
    queueCapable && !pendingPromptsAllUnanswerableHere(selectAgentSessionCurrentRequests(state))
  )
}

export type StructuredMobileSendAttachment =
  | (StructuredAgentSessionAttachment & { kind?: 'image'; id?: string })
  | { kind: 'file'; id?: string; path: string }

export function useMobileStructuredSendWithOutcome(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  queueCapable: boolean
  commandsWait: boolean
  stateRef: { readonly current: StructuredAgentSessionState }
  stopping: boolean
  accept: MobileStructuredSends['accept']
  hold: MobileStructuredSends['hold']
  commandPending: { current: boolean }
  controller: Pick<
    StructuredAgentSessionComposerOptions,
    'snapshot' | 'setOption' | 'invokeAction' | 'conversationCommands'
  >
  onSendError: MobileNativeChatSendErrorReporter
  // Older hosts accept neither per-chat model nor effort.
  sendOptions?: () => Readonly<Record<string, string>> | undefined
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
    sendOptions,
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
      const imageAttachments: StructuredAgentSessionAttachment[] = []
      const files: { path: string }[] = []
      for (const attachment of sendAttachments) {
        if (attachment.kind === 'file') {
          files.push(attachment)
        } else {
          imageAttachments.push(attachment)
        }
      }
      const wireText = nativeChatTextWithFileReferences(text, files)
      const body = structuredAgentSessionSendBody(wireText, imageAttachments)
      if (body.blocks.length === 0) {
        return 'rejected'
      }
      const send = {
        clientMessageId: structuredSessionOperationId(),
        body,
        queuedAt: Date.now(),
        ...(stopping ? { sentWhileStopping: true as const } : {})
      }
      // Wait for pending picks so the send carries this chat’s settled options.
      const options = sendOptions?.()
      const outcome = await sendMobileStructuredAgentSessionMessage({
        client,
        sessionId,
        expectedRuntimeFence: currentFence,
        text: wireText,
        attachments: imageAttachments,
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
      sendOptions,
      sessionId,
      stateRef,
      stopping
    ]
  )
}
