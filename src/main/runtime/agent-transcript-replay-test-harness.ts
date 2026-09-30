// Replays captured PTY bytes the way onPtyData does, for suites asserting a rule on every frame.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { projectTerminalVisibleLines } from './orca-runtime-terminal-projection'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { buildPreview } from './terminal-tail-state'
import { buildTerminalWaitText } from './terminal-wait-tail-state'

const DEFAULT_CHUNK_CHARS = 64

export type TranscriptReplayFrame = { screenLines: string[]; waitText: string }

export function readRuntimeFixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

/** A string is cut into fixed 64-char chunks; an array replays the recorded PTY chunks as-is. */
export async function* replayTranscript(
  data: string | readonly string[],
  cols: number,
  rows: number
): AsyncGenerator<TranscriptReplayFrame> {
  const chunks = typeof data === 'string' ? splitIntoChunks(data) : data
  const emulator = new HeadlessEmulator({ cols, rows })
  let lines: string[] = []
  let partialLine = ''
  let pendingAnsi = ''
  let redrawCursor: ReturnType<typeof appendNormalizedToTailBuffer>['redrawCursor'] = null
  try {
    for (const chunk of chunks) {
      await emulator.write(chunk)
      const normalized = normalizeTerminalChunk(chunk, pendingAnsi)
      pendingAnsi = normalized.pendingAnsi
      const tail = appendNormalizedToTailBuffer(lines, partialLine, normalized.text, redrawCursor)
      lines = tail.lines
      partialLine = tail.partialLine
      redrawCursor = tail.redrawCursor
      yield {
        screenLines: projectTerminalVisibleLines(emulator).lines,
        waitText: buildTerminalWaitText(lines, partialLine, buildPreview(lines, partialLine))
      }
    }
  } finally {
    emulator.dispose()
  }
}

function splitIntoChunks(data: string): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < data.length; offset += DEFAULT_CHUNK_CHARS) {
    chunks.push(data.slice(offset, offset + DEFAULT_CHUNK_CHARS))
  }
  return chunks
}
