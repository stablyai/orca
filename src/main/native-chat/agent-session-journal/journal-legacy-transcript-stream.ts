import { createReadStream } from 'node:fs'
import { decodeTranscriptStream } from '../transcript-stream-lines'
import { readCodexLocalHistory } from '../codex-local-history'

export async function readLegacyImportTranscript(
  input: { filePath: string; codex: boolean; roots?: readonly string[] },
  visit: (line: string, fallbackId: string, recordId?: string, selected?: boolean) => null
): Promise<{ consumedBytes: number }> {
  return input.codex
    ? {
        consumedBytes: await readCodexLocalHistory({
          ...input,
          visit: (line, fallbackId, selected, recordId) =>
            visit(line, fallbackId, recordId, selected)
        })
      }
    : decodeTranscriptStream(
        createReadStream(input.filePath),
        input.filePath,
        0,
        visit,
        true,
        16 * 1024 * 1024
      )
}
