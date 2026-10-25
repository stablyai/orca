import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { projectTerminalVisibleLines } from './orca-runtime-terminal-projection'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { buildPreview } from './terminal-tail-state'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import { visibleNonBlankTerminalLines } from './terminal-tail-read'

const DEFAULT_CHUNK_CHARS = 64

/** Live emulator rows and trusted ruled-grid rows, respectively. */
export type TranscriptReplayFrame = {
  screenLines: string[]
  ruledScreenLines: string[]
  waitText: string
}

export function readRuntimeFixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

export type TimedRuntimeFixture = {
  chunks: string[]
  /** Milliseconds since spawn. */
  times: number[]
  promptSentAtMs?: number
  /** Recording end; no bytes arrived after the final read. */
  recordedUntilMs?: number
}

export function readTimedRuntimeFixture(name: string): TimedRuntimeFixture {
  const data = readRuntimeFixture(name)
  const timing: {
    chunks: [number, number][]
    promptSentAtMs?: number
    recordedUntilMs?: number
  } = JSON.parse(readFileSync(join(__dirname, '__fixtures__', `${name}.timing.json`), 'utf8'))
  const chunks: string[] = []
  let offset = 0
  for (const [, length] of timing.chunks) {
    chunks.push(data.slice(offset, offset + length))
    offset += length
  }
  if (offset !== data.length) {
    throw new Error(`${name}.timing.json covers ${offset} of ${data.length} chars`)
  }
  return {
    chunks,
    times: timing.chunks.map(([at]) => at),
    ...(timing.promptSentAtMs !== undefined ? { promptSentAtMs: timing.promptSentAtMs } : {}),
    ...(timing.recordedUntilMs !== undefined ? { recordedUntilMs: timing.recordedUntilMs } : {})
  }
}

export type TranscriptReplayResize = { atChunk: number; cols: number; rows: number }

/** Strings use 64-character chunks; arrays preserve recorded PTY read boundaries. */
export async function* replayTranscript(
  data: string | readonly string[],
  cols: number,
  rows: number,
  resize?: TranscriptReplayResize
): AsyncGenerator<TranscriptReplayFrame> {
  const chunks = typeof data === 'string' ? splitTranscriptIntoChunks(data) : data
  const emulator = new HeadlessEmulator({ cols, rows })
  let lines: string[] = []
  let partialLine = ''
  let pendingAnsi = ''
  let redrawCursor: ReturnType<typeof appendNormalizedToTailBuffer>['redrawCursor'] = null
  try {
    for (const [index, chunk] of chunks.entries()) {
      if (index === resize?.atChunk) {
        emulator.resize(resize.cols, resize.rows)
      }
      await emulator.write(chunk)
      const normalized = normalizeTerminalChunk(chunk, pendingAnsi)
      pendingAnsi = normalized.pendingAnsi
      const tail = appendNormalizedToTailBuffer(lines, partialLine, normalized.text, redrawCursor)
      lines = tail.lines
      partialLine = tail.partialLine
      redrawCursor = tail.redrawCursor
      yield {
        screenLines: projectTerminalVisibleLines(emulator).lines,
        ruledScreenLines: visibleNonBlankTerminalLines(emulator.getVisibleLines()),
        waitText: buildTerminalWaitText(lines, partialLine, buildPreview(lines, partialLine))
      }
    }
  } finally {
    emulator.dispose()
  }
}

export async function finalReplayFrame(
  name: string,
  cols: number,
  rows: number,
  resize?: TranscriptReplayResize
): Promise<TranscriptReplayFrame> {
  let last: TranscriptReplayFrame | null = null
  for await (const frame of replayTranscript(readRuntimeFixture(name), cols, rows, resize)) {
    last = frame
  }
  if (!last) {
    throw new Error(`empty fixture ${name}`)
  }
  return last
}

/** terminal read --screen projection with composer draft blanked. */
export async function finalReadProjection(
  name: string,
  cols: number,
  rows: number
): Promise<{ lines: string[]; draft?: string }> {
  const emulator = new HeadlessEmulator({ cols, rows })
  try {
    for (const chunk of splitTranscriptIntoChunks(readRuntimeFixture(name))) {
      await emulator.write(chunk)
    }
    return projectTerminalVisibleLines(emulator)
  } finally {
    emulator.dispose()
  }
}

export function splitTranscriptIntoChunks(data: string): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < data.length; offset += DEFAULT_CHUNK_CHARS) {
    chunks.push(data.slice(offset, offset + DEFAULT_CHUNK_CHARS))
  }
  return chunks
}
