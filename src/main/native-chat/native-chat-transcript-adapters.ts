import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import {
  NATIVE_CHAT_AGENT_ADAPTERS,
  type NativeChatTranscriptAgent
} from '../../shared/native-chat-agent-adapters'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine
} from './transcript-line-decoders'
import {
  decodeClaudeTurnLifecycle,
  decodeCodexTurnLifecycle,
  type NativeChatTurnLifecycleDecoder
} from './transcript-turn-lifecycle'

/** Decodes one provider JSONL record into a normalized Chat UI message. */
export type NativeChatLineDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export type NativeChatTranscriptAdapter = Readonly<{
  /** Maps one provider JSONL record into Orca's normalized message model. */
  decodeLine: NativeChatLineDecoder
  /** Maps explicit provider turn boundaries when the transcript family exposes them. */
  decodeLifecycle: NativeChatTurnLifecycleDecoder | null
}>

const NATIVE_CHAT_TRANSCRIPT_ADAPTERS: Readonly<
  Record<NativeChatTranscriptAgent, NativeChatTranscriptAdapter>
> = Object.freeze({
  claude: Object.freeze({
    decodeLine: decodeClaudeTranscriptLine,
    decodeLifecycle: decodeClaudeTurnLifecycle
  }),
  codex: Object.freeze({
    decodeLine: decodeCodexTranscriptLine,
    decodeLifecycle: decodeCodexTurnLifecycle
  }),
  grok: Object.freeze({
    decodeLine: decodeGrokTranscriptLine,
    decodeLifecycle: null
  })
})

/** Resolves the main-process line and lifecycle decoders registered for an agent. */
export function nativeChatTranscriptAdapterForAgent(
  agent: string | null | undefined
): NativeChatTranscriptAdapter | null {
  const descriptor = NATIVE_CHAT_AGENT_ADAPTERS.get(agent)
  return descriptor ? NATIVE_CHAT_TRANSCRIPT_ADAPTERS[descriptor.transcriptAgent] : null
}

/** Decodes one provider transcript record with the adapter's line decoder. */
export function decodeNativeChatTranscriptLine(
  adapter: NativeChatTranscriptAdapter,
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  return adapter.decodeLine(line, fallbackId)
}

/** Decodes an optional turn boundary without inferring lifecycle from visible messages. */
export function decodeNativeChatTurnLifecycle(
  adapter: NativeChatTranscriptAdapter,
  line: string,
  fallbackId: string
): NativeChatTurnLifecycle | null {
  return adapter.decodeLifecycle?.(line, fallbackId) ?? null
}
