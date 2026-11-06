import { createReadStream } from 'node:fs'
import { parseJsonObject } from '../../ai-vault/session-scanner-values'
import { decodeTranscriptStream } from '../transcript-stream-lines'
import { readCodexLocalHistory } from '../codex-local-history'

export async function readLegacyImportTranscript(
  input: { filePath: string; codex: boolean; roots?: readonly string[] },
  visit: (
    line: string,
    fallbackId: string,
    record: Record<string, unknown> | null,
    recordId?: string,
    selected?: boolean
  ) => null
): Promise<{ consumedBytes: number }> {
  return input.codex
    ? {
        consumedBytes: await readCodexLocalHistory({
          ...input,
          visit: (line, fallbackId, selected, recordId, record) =>
            visit(line, fallbackId, record, recordId, selected)
        })
      }
    : decodeTranscriptStream(
        createReadStream(input.filePath),
        input.filePath,
        0,
        (line, fallbackId) => visit(line, fallbackId, parseJsonObject(line)),
        true,
        16 * 1024 * 1024
      )
}
