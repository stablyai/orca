import { createReadStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { parseJsonObject } from '../../../ai-vault/session-scanner-values'
import { splitTranscriptStreamLines } from '../../transcript-stream-lines'
import { readCodexLocalHistory, type CodexHistoryRecord } from '../../codex-local-history'
import { transcriptFallbackId } from '../../transcript-fallback-id'
import { throwIfSignalAborted } from '../../../../shared/abort-signal-reason'

export async function readLegacyImportTranscript(
  input: {
    filePath: string
    codex: boolean
    roots?: readonly string[]
    signal?: AbortSignal
    parseRecord?: (line: string) => Promise<Record<string, unknown> | null>
  },
  visit: (
    line: string,
    fallbackId: string,
    record: Record<string, unknown> | null,
    recordId?: string,
    selected?: boolean
  ) => null | Promise<null>,
  visitRecord?: (record: CodexHistoryRecord) => void | Promise<void>
): Promise<{ consumedBytes: number }> {
  throwIfSignalAborted(input.signal)
  if (input.codex) {
    return {
      consumedBytes: await readCodexLocalHistory({
        ...input,
        visitRecord,
        visit: async (line, fallbackId, selected, recordId, record) => {
          await visit(line, fallbackId, record, recordId, selected)
        }
      })
    }
  }
  const stream = createReadStream(input.filePath, { signal: input.signal })
  let consumedBytes = 0
  try {
    for await (const raw of splitTranscriptStreamLines(stream, 16 * 1024 * 1024)) {
      throwIfSignalAborted(input.signal)
      const offset = consumedBytes
      consumedBytes += raw.byteLength
      const line = raw.line.endsWith('\r') ? raw.line.slice(0, -1) : raw.line
      if (!line) {
        continue
      }
      const record = input.parseRecord ? await input.parseRecord(line) : parseJsonObject(line)
      await visit(line, transcriptFallbackId(input.filePath, offset), record)
    }
    throwIfSignalAborted(input.signal)
    return { consumedBytes }
  } catch (error) {
    throwIfSignalAborted(input.signal)
    throw error
  } finally {
    stream.destroy()
    await Promise.allSettled([finished(stream, { cleanup: true })])
  }
}
