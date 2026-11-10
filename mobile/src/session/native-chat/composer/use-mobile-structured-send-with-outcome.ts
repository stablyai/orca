import { agentSessionInteractionCommand } from '../../../../../src/shared/agent-session/options/agent-session-interaction-mode'
import { selectAgentSessionCurrentRequests } from '../../../../../src/shared/agent-session/requests/agent-session-current-requests'
import { useCallback } from 'react'
import { runningStructuredAgentSessionTurnId } from '../../../../../src/shared/agent-session/view/structured-agent-session-live-turn'
import { mobileStructuredAgentSessionWorking } from '../agent-session/mobile-structured-agent-session-working'
import { structuredSessionBackgroundTasksView } from '../../../../../src/shared/structured-session-background-tasks-view'
import { agentSessionVisibleFailureFacts } from '../../../../../src/shared/agent-session/failures/agent-session-visible-failures'
import { tuiAgentDisplayName } from '../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { pendingPromptsAllUnanswerableHere } from '../../../../../src/shared/agent-session/agent-session-approval-subject'
import {
  SkillRefLimitError,
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment,
  type StructuredAgentSessionSendControl
} from '../../../../../src/shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { MAX_SKILL_REFS } from '../../../../../src/shared/rpc-contract/structured-agent-session-message-params'
import {
  structuredAgentSessionGoalObjective,
  type StructuredAgentSessionComposerOptions
} from '../../../../../src/shared/agent-session/view/structured-agent-session-composer'
import { translate } from '../../../i18n/mobile-i18n'
import type { AgentSessionSlashCommand } from '../../../../../src/shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionState } from '../../../../../src/shared/agent-session/structured-agent-session-reducer'
import { mobileStructuredSendQueues } from './mobile-structured-send-queue-rule'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type {
  MobileNativeChatSendIntent,
  MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import { dispatchMobileStructuredCommand } from './mobile-structured-composer-command'
import type { MobileNativeChatSendErrorReporter } from './use-mobile-native-chat-send-error'
import { sendMobileStructuredAgentSessionMessage } from '../agent-session/mobile-structured-agent-session-send'
import type { MobileStructuredSends } from './use-mobile-structured-sends'
import type { MobileStructuredSendsOut } from './use-mobile-structured-stop-offer'
import { structuredSessionOperationId } from '../agent-session/structured-session-operation-id'
import { UNCONFIRMED_SEND_MESSAGE } from './use-mobile-native-chat-unconfirmed-sends'
import { timeoutForDeadline } from '../agent-session/mobile-structured-agent-session-rpc'
import { nativeChatTextWithFileReferences } from './mobile-native-chat-file-attachment'
import {
  actionableStructuredApproval,
  actionableStructuredQuestion
} from '../input/mobile-structured-actionable-prompt'

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
  acknowledge: MobileStructuredSends['acknowledge']
  reject: MobileStructuredSends['reject']
  holdUnconfirmed: MobileStructuredSends['holdUnconfirmed']
  commandPending: { current: boolean }
  onClearSent: () => () => void
  /** This chat's message sends still out, which a command waits behind as on desktop. */
  sendsOut: MobileStructuredSendsOut
  controller: Pick<
    StructuredAgentSessionComposerOptions,
    | 'snapshot'
    | 'setOption'
    | 'invokeAction'
    | 'conversationCommands'
    | 'compactInstructions'
    | 'changeThreadGoal'
  >
  sessionCommands?: readonly AgentSessionSlashCommand[]
  onSendError: MobileNativeChatSendErrorReporter
  // Older hosts accept neither per-chat model nor effort.
  /** The chat's own model and effort each send carries; absent for an older host, which takes neither. */
  sendSelection?: () => Pick<StructuredAgentSessionSendControl, 'options' | 'selection'>
  sendOptions?: () => Readonly<Record<string, string>> | undefined
  // An older host refuses a send body carrying `skills`; there the `$name` text stands alone.
  takesSkills?: boolean
}): (
  text: string,
  images?: string[],
  deadline?: number,
  attachments?: readonly StructuredMobileSendAttachment[],
  skills?: readonly AgentJournalSkillRef[],
  intent?: MobileNativeChatSendIntent
) => Promise<MobileNativeChatSendOutcome> {
  const {
    accept,
    acknowledge,
    agent,
    client,
    commandPending,
    commandsWait,
    controller,
    enabled,
    onClearSent,
    reject,
    holdUnconfirmed,
    onSendError,
    queueCapable,
    queueFollowUps,
    queueSendsNext,
    sendOptions,
    sendsOut,
    sessionCommands,
    sendSelection,
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
      pickedSkills?: readonly AgentJournalSkillRef[],
      intent?: MobileNativeChatSendIntent
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
      const captured = sendSelection?.() ?? { options: sendOptions?.() }
      const sendAttachments = attachments ?? []
      const hasAttachments = Boolean(sendAttachments.length || images?.length)
      // Goal mode: the host sets the objective, or an agent-owned goal takes it as its own /goal.
      const objective = intent?.goal ? structuredAgentSessionGoalObjective(text) : null
      if (objective === '') {
        return 'rejected'
      }
      if (objective !== null && hasAttachments) {
        onSendError(
          translate('chat.goal.attachmentsUnsupported', 'Remove attachments before setting a goal.')
        )
        return 'rejected'
      }
      if (objective !== null && controller.changeThreadGoal) {
        return (await controller.changeThreadGoal({ kind: 'set', objective }))
          ? 'accepted'
          : 'rejected'
      }
      const messageText = objective === null ? text : `/goal ${objective}`
      const pickedModeSkill =
        agentSessionInteractionCommand(agent ?? '', messageText) !== null &&
        pickedSkills?.some((skill) => messageText.trimEnd() === `/${skill.name}`)
      const commandOutcome = pickedModeSkill
        ? null
        : await dispatchMobileStructuredCommand({
            text: messageText,
            hasAttachments,
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
                working: mobileStructuredAgentSessionWorking(state) || queueSendsNext,
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
              !pendingPromptsAllUnanswerableHere(
                selectAgentSessionCurrentRequests(stateRef.current)
              ),
            onError: onSendError,
            onClearSent,
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
      const wireText = nativeChatTextWithFileReferences(messageText, files)
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
        clientMessageId: intent?.clientMessageId ?? structuredSessionOperationId(),
        body,
        queuedAt: Date.now(),
        ...captured,
        afterSequence: stateRef.current.cursor?.sequence,
        ...(stopping ? { sentWhileStopping: true as const } : {})
      }
      accept(send, images)
      intent?.onCreated?.(send.clientMessageId)
      const outcome = await sendsOut.trackSend(sendMobileStructuredAgentSessionMessage)({
        client,
        sessionId,
        expectedRuntimeFence: currentFence,
        text: wireText,
        attachments: imageAttachments,
        skills,
        // Resolved from the chat as it is now: a hold-menu choice made mid-turn may land after it.
        ...(mobileStructuredSendQueues(queueCapable, queueFollowUps, stateRef.current, {
          alternate: intent?.alternate,
          isWorking: mobileStructuredAgentSessionWorking(stateRef.current) || queueSendsNext,
          stopping
        })
          ? { delivery: 'queue-if-active' as const }
          : {}),
        ...captured,
        ...(intent?.usageLimitContinuationOfTurnItemId
          ? { usageLimitContinuationOfTurnItemId: intent.usageLimitContinuationOfTurnItemId }
          : {}),
        deadline,
        clientMessageId: send.clientMessageId,
        onAccepted: (cursor) => acknowledge(send.clientMessageId, cursor),
        onError: onSendError
      })
      if (outcome === 'rejected' || outcome === 'queued') {
        reject(send.clientMessageId)
      } else if (outcome === 'unknown') {
        // Answers and continuations have no box to return to: drop the bubble with a warning. The composer re-holds its sends to hand them back.
        holdUnconfirmed(send.clientMessageId, () => onSendError(UNCONFIRMED_SEND_MESSAGE))
      }
      return outcome
    },
    [
      accept,
      acknowledge,
      agent,
      client,
      commandPending,
      commandsWait,
      controller,
      enabled,
      onClearSent,
      reject,
      holdUnconfirmed,
      onSendError,
      queueCapable,
      queueFollowUps,
      queueSendsNext,
      sendOptions,
      sendsOut,
      sessionCommands,
      sendSelection,
      sessionId,
      stateRef,
      stopping,
      takesSkills
    ]
  )
}
