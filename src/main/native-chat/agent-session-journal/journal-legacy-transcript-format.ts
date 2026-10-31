import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat-agent-support'
import type { NativeChatLineDecoder } from '../transcript-tail-reader'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine,
  decodeOmpTranscriptLine
} from '../transcript-line-decoders'

const LINE_DECODERS = {
  claude: decodeClaudeTranscriptLine,
  codex: decodeCodexTranscriptLine,
  grok: decodeGrokTranscriptLine,
  omp: decodeOmpTranscriptLine
} as const

export type LegacyLineTranscriptFormat = {
  transcriptAgent: keyof typeof LINE_DECODERS
  decode: NativeChatLineDecoder
}

export function resolveLegacyTranscriptFormat(
  agent: string | null | undefined
): LegacyLineTranscriptFormat | { transcriptAgent: 'opencode'; decode: null } | null {
  // Pi keeps its own source identity while sharing OMP's serialization format.
  const transcriptAgent = agent === 'pi' ? 'omp' : resolveNativeChatTranscriptAgent(agent)
  if (!transcriptAgent) {
    return null
  }
  return transcriptAgent === 'opencode'
    ? { transcriptAgent, decode: null }
    : { transcriptAgent, decode: LINE_DECODERS[transcriptAgent] }
}
