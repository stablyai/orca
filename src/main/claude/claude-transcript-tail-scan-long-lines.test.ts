// Lines longer than one 64KiB read block.
//
// The scan widens its window when a block holds no complete line. Getting that
// widening condition wrong does not fail — it spins, so these tests cap the
// number of reads: a non-terminating scan surfaces as a thrown read cap here
// rather than as a hung suite.

import type * as NodeFsPromises from 'node:fs/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claudeTranscriptTailLines,
  TRANSCRIPT_TAIL_READ_LIMIT_BYTES,
  type ClaudeTranscriptTailScan
} from './claude-transcript-tail-scan'

const harness = vi.hoisted(() => ({ reads: 0, readCap: 4096, opened: 0, closed: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    open: async (path: string, flags: string) => {
      const handle = await actual.open(path, flags)
      harness.opened += 1
      return {
        stat: () => handle.stat(),
        read: (buffer: Buffer, offset: number, length: number, position: number) => {
          harness.reads += 1
          if (harness.reads > harness.readCap) {
            throw new Error(`tail scan made ${harness.reads} reads without terminating`)
          }
          return handle.read(buffer, offset, length, position)
        },
        close: async () => {
          harness.closed += 1
          await handle.close()
        }
      }
    }
  }
})

const CHUNK_BYTES = 64 * 1024

let root: string

beforeEach(async () => {
  harness.reads = 0
  harness.readCap = 4096
  harness.opened = 0
  harness.closed = 0
  root = await mkdtemp(join(tmpdir(), 'orca-claude-long-'))
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

describe('claudeTranscriptTailLines over-long lines', () => {
  // 65535 content bytes + its terminator exactly fills the 64KiB block, so the
  // block's only newline is its last byte: the shape that used to spin.
  it.each([65533, 65534, 65535, 65536, 70000])(
    'yields a %i-byte line that fills or overflows one read block',
    async (contentBytes) => {
      const long = 'L'.repeat(contentBytes)
      const path = await write(`line-${contentBytes}.jsonl`, `head\n${long}\n`)

      await expect(collect(path)).resolves.toEqual([long, 'head'])
    }
  )

  it('yields a line spanning several read blocks', async () => {
    const long = 'L'.repeat(200 * 1024)
    const path = await write('spanning.jsonl', `head\n${long}\ntail\n`)

    await expect(collect(path)).resolves.toEqual(['tail', long, 'head'])
  })

  it('keeps ordering when the over-long line is not the last line', async () => {
    const long = 'L'.repeat(65636)
    const path = await write('not-last.jsonl', `a\n${long}\ntail1\ntail2\n`)

    await expect(collect(path)).resolves.toEqual(['tail2', 'tail1', long, 'a'])
  })

  it('yields an over-long final line that has no trailing newline', async () => {
    const long = 'L'.repeat(65535)
    const path = await write('unterminated.jsonl', `head\n${long}`)

    await expect(collect(path)).resolves.toEqual([long, 'head'])
  })

  it('reports reaching the start of a file whose only line is over-long', async () => {
    const long = 'L'.repeat(150 * 1024)
    const path = await write('single.jsonl', `${long}\n`)
    const scan: ClaudeTranscriptTailScan = { reachedFileStart: false }

    await expect(collect(path, scan)).resolves.toEqual([long])
    expect(scan.reachedFileStart).toBe(true)
  })

  it('still stops at the read limit when every line is over-long', async () => {
    const line = `${'x'.repeat(100 * 1024 - 1)}\n`
    const path = await write(
      'huge-lines.jsonl',
      Buffer.from(
        line.repeat(Math.ceil(TRANSCRIPT_TAIL_READ_LIMIT_BYTES / line.length) + 4),
        'utf8'
      )
    )
    const scan: ClaudeTranscriptTailScan = { reachedFileStart: false }

    const lines = await collect(path, scan)

    expect(scan.reachedFileStart).toBe(false)
    expect(lines.length).toBeLessThan(TRANSCRIPT_TAIL_READ_LIMIT_BYTES / (100 * 1024) + 4)
  })
})

describe('claudeTranscriptTailLines file descriptor', () => {
  it('closes the handle after a completed scan', async () => {
    const path = await write('done.jsonl', `head\n${'L'.repeat(CHUNK_BYTES)}\n`)

    await collect(path)

    expect(harness.opened).toBe(1)
    expect(harness.closed).toBe(1)
  })

  it('closes the handle when the consumer stops early', async () => {
    const path = await write('early.jsonl', `head\n${'L'.repeat(CHUNK_BYTES)}\n`)

    for await (const line of claudeTranscriptTailLines(path)) {
      expect(line).toBeTruthy()
      break
    }

    expect(harness.closed).toBe(1)
  })

  it('closes the handle when a read throws', async () => {
    harness.readCap = 1
    const path = await write('failing.jsonl', `head\n${'L'.repeat(200 * 1024)}\n`)

    await expect(collect(path)).rejects.toThrow('without terminating')

    expect(harness.opened).toBe(1)
    expect(harness.closed).toBe(1)
  })
})
