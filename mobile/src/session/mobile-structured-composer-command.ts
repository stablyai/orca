import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../src/shared/agent-session/agent-session-conversation-command'
import type { AgentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  type StructuredAgentSessionCommandRefusalCause,
  type StructuredAgentSessionComposerOptions
} from '../../../src/shared/structured-agent-session-composer'
import {
  conversationCommandReply,
  heldConversationCommandParts,
  structuredConversationCommandHold
} from '../../../src/shared/structured-conversation-command-hold'
import { mobileAgentSessionWriteNoticeText } from './agent-session-write-notice-copy'
import type { RpcClient } from '../transport/rpc-client'
import { translate } from '../i18n/mobile-i18n'
import { sayMobileAgentSessionFailure } from './agent-session-failure-copy'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import { requestStructuredAgentSessionMutation } from './mobile-structured-agent-session-rpc'
import type { MobileNativeChatSendErrorReporter } from './native-chat/use-mobile-native-chat-send-error'

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
  timeoutMs: number
}): Promise<MobileNativeChatSendOutcome | null> {
  if (
    !isStructuredAgentSessionComposerCommand(
      input.text,
      input.controller.agent,
      input.controller.sessionCommands
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
    runConversationCommand: async (command) => {
      const held = (hold: Parameters<typeof heldConversationCommandParts>[1]) =>
        mobileAgentSessionWriteNoticeText(heldConversationCommandParts(command, hold))
      // A command on its way is the agent's work in flight.
      if (input.pending.current) {
        return { accepted: false, error: held('working') }
      }
      const shown = input.holds()
      const waitsInLine = input.waitsInLine(command)
      const hold = structuredConversationCommandHold({
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
      try {
        const result =
          await requestStructuredAgentSessionMutation<AgentSessionConversationCommandResult>({
            client: input.client,
            sessionId: input.sessionId,
            expectedRuntimeFence: input.fence,
            method: 'agentSession.conversationCommand',
            fingerprintMethod: 'agentSession.conversationCommand',
            fields: waitsInLine ? { command, delivery: 'queue-if-active' } : { command },
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
        if (result.status !== 'accepted') {
          return { accepted: false, error: result.message }
        }
        const reply = conversationCommandReply(result.value, {
          agentName: input.agentName,
          startFailures: input.startFailures(),
          say: sayMobileAgentSessionFailure
        })
        // A refusal names its cause only when the phone showed it, as on desktop.
        return {
          accepted: reply.accepted,
          error: reply.error,
          ...(reply.error &&
          reply.cause !== undefined &&
          reply.cause !== 'retry' &&
          shown[reply.cause]
            ? { refusedWhile: reply.cause }
            : {})
        }
      } finally {
        input.pending.current = false
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
