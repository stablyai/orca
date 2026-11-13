import { homedir } from 'node:os'
import { AgentConversationCopyError } from '../../../native-chat/conversation-adoption/agent-conversation-copy-error'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ZcodeChatCredentials } from '../credentials/zcode-chat-credentials'
import {
  copyZcodeConversation,
  forkZcodeForRewind,
  ZcodeConversationCopyRefusedError
} from '../conversation/zcode-conversation-copy'

// Fork-to-new-chat and rewind-by-fork both resolve against persisted zcode sessions over a
// disposable backend, so they work with a live child or at rest. Anchors are the provider's own
// input message ids; `session/messages` matches them against the session's cold history.

/** The plan credentials runtime-header asks are answered with; null declines them. */
type ZcodeForkDeps = {
  resolveChatCredentials: () => ZcodeChatCredentials | null
}

export function zcodeCopyConversation(
  deps: ZcodeForkDeps,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['copyConversation']>>[0]
): ReturnType<NonNullable<StructuredAgentSessionAdapter['copyConversation']>> {
  return copyZcodeConversation({
    environment: process.env,
    credentials: deps.resolveChatCredentials(),
    providerSessionId: input.providerSessionId,
    throughMessageId:
      input.checkpoint?.rootMessage?.uuid ?? input.checkpoint?.throughMessage?.uuid ?? null,
    ...(input.signal ? { signal: input.signal } : {})
  }).catch((error: unknown) => {
    throw new AgentConversationCopyError(
      error instanceof ZcodeConversationCopyRefusedError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error)
    )
  })
}

export function zcodeForkForRewind(
  deps: ZcodeForkDeps,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['forkForRewind']>>[0]
): ReturnType<NonNullable<StructuredAgentSessionAdapter['forkForRewind']>> {
  return forkZcodeForRewind({
    environment: process.env,
    credentials: deps.resolveChatCredentials(),
    providerSessionId: input.beforeMessage.sessionId,
    cutMessageId: input.beforeMessage.uuid,
    workspaceCwd: input.record.launchDirectory ?? homedir()
  })
}
