import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FileHandle } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  path: '',
  growth: '',
  readError: false,
  bytesRead: 0,
  peakChunkBytes: 0,
  streams: 0,
  closes: 0,
  opens: 0,
  observedStatBytes: 0
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    open: async (path: string, flags: string) => {
      const handle = await fs.open(path, flags)
      if (path !== state.path) {
        return handle
      }
      state.opens += 1
      return {
        stat: async () => {
          const snapshot = await handle.stat()
          state.observedStatBytes = snapshot.size
          if (state.growth) {
            const growth = state.growth
            state.growth = ''
            await fs.appendFile(path, growth)
          }
          return snapshot
        },
        createReadStream: (options: Parameters<FileHandle['createReadStream']>[0]) => {
          state.streams += 1
          const stream = handle.createReadStream(options)
          if (state.readError) {
            queueMicrotask(() => stream.destroy(new Error('Injected read failure')))
            return stream
          }
          stream.on('data', (chunk: Buffer | string) => {
            const size = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
            state.bytesRead += size
            state.peakChunkBytes = Math.max(state.peakChunkBytes, size)
          })
          return stream
        },
        close: async () => {
          state.closes += 1
          await handle.close()
        }
      }
    }
  }
})

import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readClaudeProviderHistoryWindow } from './claude-structured-history-window'

const LEGACY_LIMIT = 16 * 1024 * 1024
const SOURCE = `${[
  {
    type: 'user',
    uuid: 'anchor',
    parentUuid: null,
    sessionId: 'provider',
    message: { role: 'user', content: 'before' }
  },
  {
    type: 'user',
    uuid: 'latest',
    parentUuid: 'anchor',
    sessionId: 'provider',
    message: { role: 'user', content: 'after' }
  },
  { type: 'last-prompt', sessionId: 'provider', leafUuid: 'latest' }
]
  .map((row) => JSON.stringify(row))
  .join('\n')}\n`
let directory = ''

const read = (previousLeafUuid: string | null = 'anchor') =>
  readClaudeProviderHistoryWindow({
    transcriptPath: state.path,
    providerSessionId: 'provider',
    previousLeafUuid,
    sessionId: 'orca',
    turnInFlight: false
  })

function padTo(bytes: number): string {
  const filler = `${JSON.stringify({ type: 'comment', note: 'x'.repeat(4096) })}\n`
  const rows = Math.ceil((bytes - Buffer.byteLength(SOURCE)) / Buffer.byteLength(filler))
  return filler.repeat(Math.max(rows, 0)) + SOURCE
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-history-source-budget-'))
  Object.assign(state, {
    path: join(directory, 'session.jsonl'),
    growth: '',
    readError: false,
    bytesRead: 0,
    peakChunkBytes: 0,
    streams: 0,
    opens: 0,
    closes: 0,
    observedStatBytes: 0
  })
  await writeFile(state.path, SOURCE)
})

afterEach(async (context) => {
  try {
    const output = process.env.ORCA_HISTORY_BUDGET_PROOF_OUTPUT
    if (output) {
      await appendFile(
        output,
        `${JSON.stringify({
          test: context.task.name,
          bytesRead: state.bytesRead,
          peakChunkBytes: state.peakChunkBytes,
          observedStatBytes: state.observedStatBytes,
          streams: state.streams,
          opens: state.opens,
          closes: state.closes
        })}\n`
      )
    }
    expect(state.closes).toBe(state.opens)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('Claude provider history source budget', () => {
  it('reads a stable history without changing prompt evidence', async () => {
    const result = await read()
    expect(result.boundaryConsistent).toBe(true)
    expect(result.items.map((item) => item.providerItemId)).toEqual(['latest'])
  })

  it('streams two passes over one descriptor rather than one whole-file read', async () => {
    await read()
    // One open for both passes: pass 2 must see the bytes pass 1 vouched for.
    expect(state.opens).toBe(1)
    expect(state.streams).toBe(2)
    expect(state.bytesRead).toBe(2 * Buffer.byteLength(SOURCE))
  })

  it('opens no second pass when nothing followed the anchor', async () => {
    await writeFile(
      state.path,
      SOURCE.split('\n')
        // Keep the marker so malformed input cannot make the no-replay assertion pass vacuously.
        .filter((line) => !line.includes('"uuid":"latest"'))
        .join('\n')
        .replace('"leafUuid":"latest"', '"leafUuid":"anchor"')
    )

    const result = await read()

    expect(result.boundaryConsistent).toBe(true)
    expect(result.items).toEqual([])
    expect(state.streams).toBe(1)
  })

  it('resolves a source past the legacy whole-file limit instead of refusing it', async () => {
    // The old bounded read returned an inconsistent boundary here, which is the
    // one answer reconciliation can never act on.
    await writeFile(state.path, padTo(LEGACY_LIMIT + 1))
    expect(state.observedStatBytes).toBe(0)

    const result = await read()

    expect(result.boundaryConsistent).toBe(true)
    expect(result.items.map((item) => item.providerItemId)).toEqual(['latest'])
    expect(state.bytesRead).toBeGreaterThan(2 * LEGACY_LIMIT)
  })

  it('reads a large history in chunks smaller than 1 MiB', async () => {
    await writeFile(state.path, padTo(LEGACY_LIMIT + 1))
    expect((await read()).boundaryConsistent).toBe(true)
    // Bound chunks handed to the framer; this does not measure retained memory.
    expect(state.peakChunkBytes).toBeLessThan(1024 * 1024)
  })

  it('refuses a single record too large to frame', async () => {
    const huge = `${JSON.stringify({ type: 'comment', note: 'x'.repeat(LEGACY_LIMIT) })}\n`
    await writeFile(state.path, huge + SOURCE)
    expect((await read()).boundaryConsistent).toBe(false)
  })

  it('replays a concurrent repair at the grown size, not the pinned one', async () => {
    const grown = `${JSON.stringify({
      type: 'user',
      uuid: 'grown',
      parentUuid: 'latest',
      sessionId: 'provider',
      message: { role: 'user', content: 'appended' }
    })}\n`
    const torn = Math.floor(grown.length / 2)
    await writeFile(state.path, SOURCE + grown.slice(0, torn))
    state.growth = grown.slice(torn)

    const result = await read()

    // The retry re-runs BOTH passes at the new size: a pass 2 left at the old
    // size would silently drop the record the proof just accepted.
    expect(result.boundaryConsistent).toBe(true)
    expect(result.items.map((item) => item.providerItemId)).toEqual(['latest', 'grown'])
    // One failed proof, a refreshed proof, then replay.
    expect(state.streams).toBe(3)
    expect(state.opens).toBe(1)
  })

  it('preserves the inconsistent result on a read error', async () => {
    state.readError = true
    expect((await read()).boundaryConsistent).toBe(false)
  })

  it('does not open a source without an anchor', async () => {
    expect((await read(null)).boundaryConsistent).toBe(false)
    expect(state.opens).toBe(0)
    expect(state.bytesRead).toBe(0)
  })
})
