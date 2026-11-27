import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat/native-chat-agent-support'
import type { TranscriptDecoderResult } from '../transcript-streaming/transcript-stream-lines'
import { decodeAntigravityTranscriptLine } from './transcript-line-decoders-antigravity'
import { decodeClaudeChatTranscriptLine } from './transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { decodeGrokTranscriptLine } from './transcript-line-decoders-grok'
import { decodeOmpTranscriptLine } from './transcript-line-decoders-omp'

export type NativeChatLineDecoder = (line: string, fallbackId: string) => TranscriptDecoderResult

const LINE_DECODERS: Partial<
  Record<ReturnType<typeof resolveNativeChatTranscriptAgent> & string, NativeChatLineDecoder>
> = {
  antigravity: decodeAntigravityTranscriptLine,
  claude: decodeClaudeChatTranscriptLine,
  codex: decodeCodexTranscriptLine,
  grok: decodeGrokTranscriptLine,
  omp: decodeOmpTranscriptLine
}

export function nativeChatLineDecoderForAgent(agent: AgentType): NativeChatLineDecoder | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return transcriptAgent ? (LINE_DECODERS[transcriptAgent] ?? null) : null
}
