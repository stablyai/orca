import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { createCodexTranscriptHistoryDecoder } from './transcript-codex-history-decoder'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { decodeGrokTranscriptLine } from './transcript-line-decoders-grok'
import { decodeOmpTranscriptLine } from './transcript-line-decoders-omp'

// Per-line record→NativeChatMessage decoders, shared by the full transcript
// reader (transcript-reader.ts) and the live tailer (transcript-watch.ts) so
// both paths apply identical record-shape mapping. Each decoder is stateless:
// it takes a single JSONL line plus a stable fallback id and returns one message
// or null (unknown/empty records are skipped, never thrown — plan KTD risk:
// schema drift). `fallbackId` is used only when the record carries no intrinsic
// id; the caller supplies a value unique per line.
//
// Why: agent-specific decoders live in dedicated modules so this barrel stays
// under the max-lines limit while callers keep a single import path.

export { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
export { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
export { decodeGrokTranscriptLine } from './transcript-line-decoders-grok'
export { decodeOmpTranscriptLine } from './transcript-line-decoders-omp'

export type NativeChatLineDecoder = ((
  line: string,
  fallbackId: string
) => NativeChatMessage | null) & { seedHistoryMode?: (line: string) => void }

export function nativeChatLineDecoderForAgent(agent: AgentType): NativeChatLineDecoder | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  if (transcriptAgent === 'codex') {
    return createCodexTranscriptHistoryDecoder()
  }
  return transcriptAgent === 'claude'
    ? decodeClaudeTranscriptLine
    : transcriptAgent === 'grok'
      ? decodeGrokTranscriptLine
      : transcriptAgent === 'omp'
        ? decodeOmpTranscriptLine
        : null
}
