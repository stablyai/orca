// Per-line record→NativeChatMessage decoders, shared by the full transcript
// reader (transcript-reader.ts) and the live tailer (transcript-watch.ts) so
// both paths apply identical record-shape mapping. A decoder takes one JSONL
// line plus a stable fallback id and returns one message or null (unknown/empty
// records are skipped, never thrown — plan KTD risk: schema drift). Codex also
// exposes a per-stream factory because pagination mode is declared in session
// metadata. `fallbackId` is used only when a record has no intrinsic id.
//
// Why: agent-specific decoders live in dedicated modules so this barrel stays
// under the max-lines limit while callers keep a single import path.

export { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
export {
  createCodexTranscriptLineDecoder,
  decodeCodexTranscriptLine
} from './transcript-line-decoders-codex'
export { decodeGrokTranscriptLine } from './transcript-line-decoders-grok'
