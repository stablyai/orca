import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudeTranscriptTailLines,
  TRANSCRIPT_TAIL_READ_LIMIT_BYTES,
  type ClaudeTranscriptTailScan
} from './claude-transcript-tail-scan'

const CHUNK_BYTES = 64 * 1024

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-tail-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(name: string, content: Buffer | string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, content)
  return path
}

async function collect(path: string, scan?: ClaudeTranscriptTailScan): Promise<string[]> {
  const lines: string[] = []
  for await (const line of claudeTranscriptTailLines(path, scan)) {
    lines.push(line)
  }
  return lines
}

/** A file whose 64KiB chunk boundary lands `offsetInMarker` bytes into `marker`. */
function fileSplittingInside(marker: string, targetLine: string, offsetInMarker = 1): Buffer {
  const line = Buffer.from(`${targetLine}\n`, 'utf8')
  const markerBytes = Buffer.from(marker, 'utf8')
  const markerAt = line.indexOf(markerBytes)
  expect(markerAt).toBeGreaterThanOrEqual(0)
  expect(offsetInMarker).toBeGreaterThan(0)
  expect(offsetInMarker).toBeLessThan(markerBytes.length)
  const splitWithinLine = markerAt + offsetInMarker
  const trailing = CHUNK_BYTES - (line.length - splitWithinLine)
  expect(trailing).toBeGreaterThan(0)
  const head = Buffer.from('{"type":"user","sessionId":"session-1"}\n', 'utf8')
  const tail = Buffer.from(`${'x'.repeat(trailing - 1)}\n`, 'utf8')
  const file = Buffer.concat([head, line, tail])
  // The boundary the reader will use falls strictly inside the marker's bytes.
  const boundary = file.length - CHUNK_BYTES
  expect(boundary).toBe(head.length + splitWithinLine)
  return file
}

/** Interior byte offsets of `marker`, every place a boundary could split it. */
function interiorOffsets(marker: string): number[] {
  return Array.from({ length: Buffer.byteLength(marker, 'utf8') - 1 }, (_, index) => index + 1)
}

describe('claudeTranscriptTailLines', () => {
  it('keeps a multi-byte character intact when it straddles a chunk boundary', async () => {
    const targetLine = '{"type":"ai-title","aiTitle":"Café ☕","sessionId":"session-1"}'
    const path = await write('boundary.jsonl', fileSplittingInside('é', targetLine))

    await expect(collect(path)).resolves.toContain(targetLine)
  })

  it('keeps a 3-byte character intact when it straddles a chunk boundary', async () => {
    const targetLine = '{"type":"ai-title","aiTitle":"Résumé du fil ☕","sessionId":"s"}'
    const path = await write('boundary-3.jsonl', fileSplittingInside('☕', targetLine))

    await expect(collect(path)).resolves.toContain(targetLine)
  })

  it.each([
    ['2-byte', 'é'],
    ['3-byte', '☕'],
    ['4-byte', '\u{1D11E}'],
    ['ZWJ sequence', '\u{1F468}‍\u{1F469}‍\u{1F467}']
  ])('keeps a %s marker intact at every boundary offset', async (label, marker) => {
    const targetLine = `{"type":"ai-title","aiTitle":"Ship ${marker} now","sessionId":"s"}`

    for (const offset of interiorOffsets(marker)) {
      const path = await write(
        `sweep-${label.replace(/\W/g, '')}-${offset}.jsonl`,
        fileSplittingInside(marker, targetLine, offset)
      )

      await expect(collect(path)).resolves.toContain(targetLine)
    }
  })

  it('yields every non-empty line newest first', async () => {
    const path = await write('small.jsonl', 'a\n\nb\nc\n')

    await expect(collect(path)).resolves.toEqual(['c', 'b', 'a'])
  })

  it('reports reaching the start of a file it read entirely', async () => {
    const path = await write('small.jsonl', 'a\nb\n')
    const scan: ClaudeTranscriptTailScan = { reachedFileStart: false }

    await collect(path, scan)

    expect(scan.reachedFileStart).toBe(true)
  })

  it('does not report reaching the start when the read limit cut the scan short', async () => {
    const line = `${'x'.repeat(1023)}\n`
    const path = await write(
      'huge.jsonl',
      Buffer.from(line.repeat(Math.ceil(TRANSCRIPT_TAIL_READ_LIMIT_BYTES / 1024) + 8), 'utf8')
    )
    const scan: ClaudeTranscriptTailScan = { reachedFileStart: false }

    await collect(path, scan)

    expect(scan.reachedFileStart).toBe(false)
  })
})
