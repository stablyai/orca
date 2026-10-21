import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../src/shared/agent-session-conversation-command'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  type StructuredAgentSessionComposerOptions
} from '../../../src/shared/structured-agent-session-composer'
import { structuredAgentSessionCommandHostRefusalCause } from '../../../src/shared/structured-agent-session-command-refusal-cause'
import { agentSessionWriteNoticeEnglish } from '../../../src/shared/agent-session-refusal-notice'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { requestStructuredAgentSessionMutation } from './mobile-structured-agent-session-rpc'
import type { MobileNativeChatSendErrorReporter } from './use-mobile-native-chat-send-error'

/** What the person sees and can do, in the words the desktop uses. */
function busyCommandText(
  command: AgentSessionConversationCommand,
  busy: 'working' | 'prompt'
): string {
  const clear = command === 'clear'
  return agentSessionWriteNoticeEnglish(
    busy === 'prompt'
      ? [clear ? 'clearAfterAnswer' : 'compactAfterAnswer']
      : ['agentStillWorking', clear ? 'runClearWhenDone' : 'runCompactWhenDone']
  )
}

export async function dispatchMobileStructuredCommand(input: {
  text: string
  hasAttachments: boolean
  client: RpcClient
  sessionId: string
  fence: number
  pending: { current: boolean }
  controller: StructuredAgentSessionComposerOptions
  /** What the agent still has in flight that refuses a command now; null when nothing does. */
  busy: () => 'working' | 'prompt' | null
  /** The host holds this command as a card behind work in flight, so nothing here holds it. */
  waitsInLine: (command: AgentSessionConversationCommand) => boolean
  /** `refusedWhile`: what the phone showed the refused command waiting on. */
  onError: MobileNativeChatSendErrorReporter
  timeoutMs: number
}): Promise<MobileNativeChatSendOutcome | null> {
  if (input.pending.current) {
    return 'rejected'
  }
  if (!isStructuredAgentSessionComposerCommand(input.text, input.controller.agent)) {
    return null
  }
  if (input.hasAttachments) {
    input.onError('Remove attachments before using a chat-session command.')
    return 'rejected'
  }
  let unknown = false
  const outcome = await dispatchStructuredAgentSessionComposerCommand(input.text, {
    ...input.controller,
    runConversationCommand: async (command) => {
      const shown = input.busy()
      const waitsInLine = input.waitsInLine(command)
      const busy = waitsInLine ? null : shown
      if (busy) {
        return { accepted: false, error: busyCommandText(command, busy), refusedWhile: busy }
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
            error: 'Conversation operation was not confirmed.'
          }
        }
        if (result.status !== 'accepted') {
          return { accepted: false, error: result.message }
        }
        // A refusal names its cause only when the phone showed it, as on desktop.
        const cause = structuredAgentSessionCommandHostRefusalCause(result.value)
        return {
          accepted: !result.value.error,
          error: result.value.error ?? null,
          ...(result.value.error && cause !== undefined && cause === shown
            ? { refusedWhile: cause }
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
