import {
  agentSessionConversationCommandFields,
  type AgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from '../../../../../src/shared/agent-session/agent-session-conversation-command'
import type { AgentSessionFailureFact } from '../../../../../src/shared/agent-session/failures/agent-session-failure'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionHostCommand,
  type StructuredAgentSessionCommandRefusalCause,
  type StructuredAgentSessionComposerOptions
} from '../../../../../src/shared/agent-session/view/structured-agent-session-composer'
import {
  conversationCommandReply,
  heldConversationCommandParts,
  structuredConversationCommandHold
} from '../../../../../src/shared/structured-conversation-command-hold'
import { mobileAgentSessionWriteNoticeText } from '../agent-session/agent-session-write-notice-copy'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { translate } from '../../../i18n/mobile-i18n'
import { sayMobileAgentSessionFailure } from '../agent-session/agent-session-failure-copy'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { requestStructuredAgentSessionMutation } from '../agent-session/mobile-structured-agent-session-rpc'
import { structuredAgentSessionCommandWriteRefusalCause } from '../../../../../src/shared/agent-session/failures/structured-agent-session-command-refusal-cause'
import type { MobileNativeChatSendErrorReporter } from './use-mobile-native-chat-send-error'

/** What the phone shows at keypress that holds a command; `background` also counts the strip mid-turn. */
export type MobileStructuredCommandHolds = Readonly<
  Record<Exclude<StructuredAgentSessionCommandRefusalCause, 'retry'>, boolean> & {
    backgroundTasksRunning: boolean
  }
>

export async function dispatchMobileStructuredCommand(input: {
  text: string
  hasAttachments: boolean
  client: RpcClient
  sessionId: string
  fence: number
  pending: { current: boolean }
  controller: StructuredAgentSessionComposerOptions
  agentName?: string
  holds: () => MobileStructuredCommandHolds
  /** What the chat's loaded start-failure rows state, read when the reply lands. */
  startFailures: () => readonly AgentSessionFailureFact[]
  // Queued commands are held by the host; client work must not refuse them first.
  waitsInLine: (command: AgentSessionConversationCommand) => boolean
  /** `refusedWhile`: what the phone showed the refused command waiting on. */
  onError: MobileNativeChatSendErrorReporter
  /** Called as a /clear goes out; the returned restore runs unless the host accepts it. */
  onClearSent?: () => () => void
  timeoutMs: number
}): Promise<MobileNativeChatSendOutcome | null> {
  if (
    !isStructuredAgentSessionHostCommand(
      input.text,
      input.controller.changeThreadGoal !== undefined,
      input.controller.agent,
      input.controller.snapshot,
      input.controller.conversationCommands,
      input.controller.cleanBackgroundTerminals
    )
  ) {
    return input.pending.current ? 'rejected' : null
  }
  if (input.hasAttachments) {
    input.onError(
      translate(
        'session.structuredComposerCommand.removeAttachments',
        'Remove attachments before using a chat-session command.'
      )
    )
    return 'rejected'
  }
  let unknown = false
  const outcome = await dispatchStructuredAgentSessionComposerCommand(input.text, {
    ...input.controller,
    cleanBackgroundTerminalsCommand: async () => {
      const result = await requestStructuredAgentSessionMutation<{ cancelled: boolean }>({
        client: input.client,
        sessionId: input.sessionId,
        expectedRuntimeFence: input.fence,
        method: 'agentSession.cancel',
        fingerprintMethod: 'agentSession.cancel',
        fields: { scope: 'background-terminals' },
        timeoutMs: input.timeoutMs
      })
      if (result.status === 'unknown') {
        unknown = true
        input.onError(
          translate(
            'session.structuredComposerCommand.operationUnconfirmed',
            'Conversation operation was not confirmed.'
          )
        )
      } else if (result.status !== 'accepted') {
        input.onError(result.message)
      }
      return result.status === 'accepted' && result.value.cancelled
    },
    runConversationCommand: async (command, instructions, _onSent, review) => {
      const held = (hold: Parameters<typeof heldConversationCommandParts>[1]) =>
        mobileAgentSessionWriteNoticeText(heldConversationCommandParts(command, hold))
      // A command on its way is the agent's work in flight.
      if (input.pending.current) {
        return { accepted: false, error: held('working') }
      }
      const shown = input.holds()
      const waitsInLine = input.waitsInLine(command)
      const hold = structuredConversationCommandHold({
        command,
        waitsInLine,
        agentWorking: shown.working,
        promptPending: shown.prompt,
        backgroundTasksRunning: shown.backgroundTasksRunning,
        sendPending: shown.sending
      })
      // The message ahead is still sending; nothing is armed.
      if (hold === 'ahead') {
        return { accepted: false, error: null }
      }
      if (hold !== null) {
        return {
          accepted: false,
          error: held(hold),
          ...(shown[hold] ? { refusedWhile: hold } : {})
        }
      }
      input.pending.current = true
      const restoreClear = command === 'clear' ? input.onClearSent?.() : undefined
      let accepted = false
      try {
        const result =
          await requestStructuredAgentSessionMutation<AgentSessionConversationCommandResult>({
            client: input.client,
            sessionId: input.sessionId,
            expectedRuntimeFence: input.fence,
            method: 'agentSession.conversationCommand',
            fingerprintMethod: 'agentSession.conversationCommand',
            fields: agentSessionConversationCommandFields(command, {
              instructions,
              review,
              delivery: waitsInLine ? 'queue-if-active' : undefined
            }),
            timeoutMs: Math.max(input.timeoutMs, 195_000)
          })
        if (
          result.status === 'unknown' ||
          (result.status === 'accepted' && result.value.state === 'unknown')
        ) {
          unknown = true
          return {
            accepted: false,
            error: translate(
              'session.structuredComposerCommand.operationUnconfirmed',
              'Conversation operation was not confirmed.'
            )
          }
        }
        // A refusal names its cause only when the phone showed it, as on desktop.
        const refusedWhile = (cause: StructuredAgentSessionCommandRefusalCause | undefined) =>
          cause !== undefined && cause !== 'retry' && shown[cause] ? { refusedWhile: cause } : {}
        if (result.status !== 'accepted') {
          return {
            accepted: false,
            error: result.message,
            ...(result.status === 'refused'
              ? refusedWhile(structuredAgentSessionCommandWriteRefusalCause(result.failure))
              : {})
          }
        }
        const reply = conversationCommandReply(result.value, {
          agentName: input.agentName,
          startFailures: input.startFailures(),
          say: sayMobileAgentSessionFailure
        })
        accepted = reply.accepted
        return {
          accepted: reply.accepted,
          error: reply.error,
          ...(reply.error ? refusedWhile(reply.cause) : {})
        }
      } finally {
        input.pending.current = false
        if (!accepted) {
          restoreClear?.()
        }
      }
    }
  })
  if (outcome.error) {
    input.onError(
      outcome.error,
      outcome.refusedWhile ? { refusedWhile: outcome.refusedWhile } : undefined
    )
  }
  return unknown ? 'unknown' : outcome.accepted ? 'accepted' : 'rejected'
}
