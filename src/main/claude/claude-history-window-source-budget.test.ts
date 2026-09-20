import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  path: '',
  growth: '',
  readError: false,
  bytesRead: 0,
  closes: 0,
  opens: 0,
  observedStatBytes: 0
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  const afterStat = async (path: string, size: number) => {
    if (path !== state.path) {
      return
    }
    state.observedStatBytes = size
    if (state.growth) {
      const growth = state.growth
      state.growth = ''
      await fs.appendFile(path, growth)
    }
  }
  return {
    ...fs,
    stat: async (path: string) => {
      const snapshot = await fs.stat(path)
      await afterStat(path, snapshot.size)
      return snapshot
    },
    readFile: async (path: string, encoding: BufferEncoding) => {
      if (path === state.path && state.readError) {
        throw new Error('Injected read failure')
      }
      const result = await fs.readFile(path, encoding)
      if (path === state.path) {
        state.bytesRead += Buffer.byteLength(result)
      }
      return result
    },
    open: async (path: string, flags: string) => {
      const handle = await fs.open(path, flags)
      if (path !== state.path) {
        return handle
      }
      state.opens += 1
      return {
        stat: async () => {
          const snapshot = await handle.stat()
          await afterStat(path, snapshot.size)
          return snapshot
        },
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (state.readError) {
            throw new Error('Injected read failure')
          }
          const result = await handle.read(buffer, offset, length, position)
          state.bytesRead += result.bytesRead
          return result
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

const LIMIT = 16 * 1024 * 1024
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

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-history-source-budget-'))
  Object.assign(state, {
    path: join(directory, 'session.jsonl'),
    growth: '',
    readError: false,
    bytesRead: 0,
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
          observedStatBytes: state.observedStatBytes,
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

  it('accepts a complete source at the existing byte limit', async () => {
    await writeFile(state.path, SOURCE + ' '.repeat(LIMIT - Buffer.byteLength(SOURCE)))
    expect((await read()).boundaryConsistent).toBe(true)
    expect(state.bytesRead).toBe(LIMIT)
  })

  it('rejects an initially oversized source before reading its contents', async () => {
    await writeFile(state.path, SOURCE + ' '.repeat(LIMIT + 1 - Buffer.byteLength(SOURCE)))
    expect((await read()).boundaryConsistent).toBe(false)
    expect(state.bytesRead).toBe(0)
  })

  it('refuses concurrent growth beyond the existing source quota', async () => {
    state.growth = ' '.repeat(LIMIT + 1024 * 1024 - Buffer.byteLength(SOURCE))
    const result = await read()
    expect(state.observedStatBytes).toBe(Buffer.byteLength(SOURCE))
    expect(result.boundaryConsistent).toBe(false)
    expect(result.items).toEqual([])
    expect(state.bytesRead).toBeLessThanOrEqual(LIMIT + 1)
  })

  it('accepts concurrent growth that stays within the quota', async () => {
    state.growth = ' \n'.repeat(32)
    expect((await read()).boundaryConsistent).toBe(true)
    expect(state.bytesRead).toBe(Buffer.byteLength(SOURCE) + 64)
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
