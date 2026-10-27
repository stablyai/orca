import { selectAgentSessionCurrentRequests } from '../../../src/shared/agent-session-current-requests'

import { useCallback } from 'react'
import { runningStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-live-turn'
import { structuredSessionBackgroundTasksView } from '../../../src/shared/structured-session-background-tasks-view'
import { agentSessionVisibleFailureFacts } from '../../../src/shared/agent-session-visible-failures'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'
import { pendingPromptsAllUnanswerableHere } from '../../../src/shared/agent-session-approval-subject'
import {
  SkillRefLimitError,
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-send-mutation'
import type { AgentJournalSkillRef } from '../../../src/shared/agent-session-journal-types'
import { MAX_SKILL_REFS } from '../../../src/shared/rpc-contract/structured-agent-session-message-params'
import type { StructuredAgentSessionComposerOptions } from '../../../src/shared/structured-agent-session-composer'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import { structuredAgentSessionQueueEnabled } from '../../../src/shared/structured-agent-session-queued-cards'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import { dispatchMobileStructuredCommand } from './mobile-structured-composer-command'
import type { MobileNativeChatSendErrorReporter } from './native-chat/use-mobile-native-chat-send-error'
import { sendMobileStructuredAgentSessionMessage } from './mobile-structured-agent-session-send'
import type { MobileStructuredSends } from './use-mobile-structured-sends'
import type { MobileStructuredSendsOut } from './use-mobile-structured-stop-offer'
import { structuredSessionOperationId } from './structured-session-operation-id'
import { timeoutForDeadline } from './mobile-structured-agent-session-rpc'
import { nativeChatTextWithFileReferences } from './native-chat/composer/mobile-native-chat-file-attachment'
import {
  actionableStructuredApproval,
  actionableStructuredQuestion
} from './mobile-structured-actionable-prompt'

export function mobileStructuredSendQueues(
  queueCapable: boolean,
  queueFollowUps: boolean,
  state: Pick<StructuredAgentSessionState, 'items' | 'currentRequests' | 'queuedMessages'>
): boolean {
  return (
    queueCapable &&
    structuredAgentSessionQueueEnabled(
      queueFollowUps,
      state,
      selectAgentSessionCurrentRequests(state)
    )
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
  queueFollowUps: boolean
  commandsWait: boolean
  stateRef: { readonly current: StructuredAgentSessionState }
  stopping: boolean
  /** The host's queue sends next: commands that cannot wait in line read the chat as working. */
  queueSendsNext: boolean
  accept: MobileStructuredSends['accept']
  hold: MobileStructuredSends['hold']
  commandPending: { current: boolean }
  /** This chat's message sends still out, which a command waits behind as on desktop. */
  sendsOut: MobileStructuredSendsOut
  controller: Pick<
    StructuredAgentSessionComposerOptions,
    'snapshot' | 'setOption' | 'invokeAction' | 'conversationCommands'
  >
  sessionCommands?: readonly AgentSessionSlashCommand[]
  onSendError: MobileNativeChatSendErrorReporter
  // Older hosts accept neither per-chat model nor effort.
  sendOptions?: () => Readonly<Record<string, string>> | undefined
  // An older host refuses a send body carrying `skills`; there the `$name` text stands alone.
  takesSkills?: boolean
}): (
  text: string,
  images?: string[],
  deadline?: number,
  attachments?: readonly StructuredMobileSendAttachment[],
  skills?: readonly AgentJournalSkillRef[]
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
    queueFollowUps,
    queueSendsNext,
    sendOptions,
    sendsOut,
    sessionCommands,
    sessionId,
    stateRef,
    stopping,
    takesSkills
  } = args
  return useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[],
      pickedSkills?: readonly AgentJournalSkillRef[]
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
        controller: { agent: agent ?? undefined, ...controller, sessionCommands },
        agentName: agent ? (tuiAgentDisplayName(agent) ?? agent) : undefined,
        holds: () => {
          const state = stateRef.current
          const turnId = runningStructuredAgentSessionTurnId(state)
          const tasks = structuredSessionBackgroundTasksView(state.backgroundTasks, turnId)
          return {
            working: turnId !== null || queueSendsNext,
            prompt: Boolean(
              actionableStructuredApproval(state) || actionableStructuredQuestion(state)
            ),
            background: tasks.show || tasks.isMonitoring,
            backgroundTasksRunning: tasks.isMonitoring,
            sending: sendsOut.sending()
          }
        },
        startFailures: () => agentSessionVisibleFailureFacts(stateRef.current.items),
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
      const skills = takesSkills ? (pickedSkills ?? []) : []
      let body: ReturnType<typeof structuredAgentSessionSendBody>
      try {
        body = structuredAgentSessionSendBody(wireText, imageAttachments, skills)
      } catch (error) {
        if (!(error instanceof SkillRefLimitError)) {
          throw error
        }
        onSendError(
          `Message not sent. Keep at most ${MAX_SKILL_REFS} selected skill files and try again.`
        )
        return 'rejected'
      }
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
      const outcome = await sendsOut.trackSend(sendMobileStructuredAgentSessionMessage)({
        client,
        sessionId,
        expectedRuntimeFence: currentFence,
        text: wireText,
        attachments: imageAttachments,
        skills,
        ...(mobileStructuredSendQueues(queueCapable, queueFollowUps, stateRef.current)
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
      queueFollowUps,
      queueSendsNext,
      sendOptions,
      sendsOut,
      sessionCommands,
      sessionId,
      stateRef,
      stopping,
      takesSkills
    ]
  )
}
