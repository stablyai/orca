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
