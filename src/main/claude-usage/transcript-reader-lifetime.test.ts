import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { observations } = vi.hoisted(() => {
  const observations: {
    handles: FileHandle[]
    afterValidationStat: (() => Promise<void>) | undefined
  } = { handles: [], afterValidationStat: undefined }
  return { observations }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      expect(observations.handles.every((handle) => handle.fd === -1)).toBe(true)
      const handle = await actual.open(...args)
      const stat = handle.stat.bind(handle)
      let stats = 0
      vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
        const snapshot = await stat(options)
        stats++
        if (stats === 2) {
          const mutate = observations.afterValidationStat
          observations.afterValidationStat = undefined
          await mutate?.()
        }
        return snapshot
      })
      observations.handles.push(handle)
      return handle
    }
  }
})

import { readClaudeUsageScanFile } from './transcript-record-parser'

let directory: string
let transcript: string

function row(input: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'reader-lifetime',
    timestamp: '2026-10-09T12:00:00.000Z',
    requestId: 'request',
    message: { id: 'message', usage: { input_tokens: input, output_tokens: 2 } }
  })}\n`
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-reader-lifetime-'))
  transcript = join(directory, 'session.jsonl')
  observations.handles.length = 0
  observations.afterValidationStat = undefined
})

afterEach(async () => {
  await Promise.all(observations.handles.map((handle) => handle.close()))
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

it('releases the pinned descriptor before consolidating duplicate token maxima', async () => {
  await writeFile(transcript, row(301) + row(503))
  const max = Math.max
  let duplicateCorrections = 0
  vi.spyOn(Math, 'max').mockImplementation((...values) => {
    if (values[0] === 301 && values[1] === 503) {
      expect(observations.handles).toHaveLength(1)
      expect(observations.handles[0].fd).toBe(-1)
      duplicateCorrections++
    }
    return max(...values)
  })

  const read = await readClaudeUsageScanFile(transcript)

  expect(duplicateCorrections).toBe(1)
  expect(read.turns).toHaveLength(1)
  expect(read.turns[0].inputTokens).toBe(503)
})

it('closes a failed generation before opening its replacement', async () => {
  await writeFile(transcript, row(301) + row(503))
  observations.afterValidationStat = () => writeFile(transcript, row(701))

  const read = await readClaudeUsageScanFile(transcript)

  expect(observations.handles).toHaveLength(2)
  expect(observations.handles.every((handle) => handle.fd === -1)).toBe(true)
  expect(read.turns).toHaveLength(1)
  expect(read.turns[0].inputTokens).toBe(701)
  expect(read.processedFile.lineCount).toBe(1)
})
