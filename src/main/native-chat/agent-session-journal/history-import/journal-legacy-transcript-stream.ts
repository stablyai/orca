import { decodeClaudeTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-codex'
import { decodeGrokTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-grok'
import { decodeOmpTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-omp'
import { createReadStream } from 'node:fs'
import { decodeTranscriptStream } from '../../transcript-streaming/transcript-stream-lines'
import {
  readCodexLocalHistory,
  type CodexHistoryRecord
} from '../../transcript-history/codex/codex-local-history'

export const MAX_LEGACY_IMPORT_RECORD_BYTES = 16 * 1024 * 1024

export async function readLegacyImportTranscript(
  input: { filePath: string; codex: boolean; roots?: readonly string[]; signal?: AbortSignal },
  visit: (line: string, fallbackId: string, recordId?: string, selected?: boolean) => null,
  visitRecord?: (record: CodexHistoryRecord) => void
): Promise<{ consumedBytes: number }> {
  return input.codex
    ? {
        consumedBytes: await readCodexLocalHistory({
          ...input,
          visitRecord,
          visit: (line, fallbackId, selected, recordId) =>
            visit(line, fallbackId, recordId, selected)
        })
      }
    : decodeTranscriptStream(
        createReadStream(input.filePath, { signal: input.signal }),
        input.filePath,
        0,
        visit,
        true,
        MAX_LEGACY_IMPORT_RECORD_BYTES
      )
}

export const TRANSCRIPT_DECODERS = {
  claude: decodeClaudeTranscriptLine,
  codex: (line: string, fallbackId: string) =>
    decodeCodexTranscriptLine(line, fallbackId, { historyImport: true }),
  grok: decodeGrokTranscriptLine,
  omp: decodeOmpTranscriptLine
} as const
