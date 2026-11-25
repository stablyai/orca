import { dirname } from 'node:path'
import { open } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseAgentRequestAnswerFile,
  readAgentRequestAnswerFile
} from './agent-request-answer-file'
import { answerFile, withAnswerBytes } from './agent-request-test-fixtures'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { parseAgentSessionOperationTimestamp } from '../../shared/agent-session/lifecycle/operations/agent-session-host-authority'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, open: vi.fn(actual.open) }
})

const MAX_BYTES = 128 * 1024

function paddedAnswer(size: number): Buffer {
  const json = JSON.stringify(answerFile())
  return Buffer.from(json + ' '.repeat(size - Buffer.byteLength(json)))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('native answer file input contract', () => {
  it('accepts the shared generator output and preserves the host operation timestamp', () => {
    const timestamp = 1795550000000
    const clientOperationId = createStructuredAgentSessionOperationId(
      () => 'ABCDEF01-2345-4678-9ABC-DEF012345678',
      timestamp
    )
    const parsed = parseAgentRequestAnswerFile({ ...answerFile(), clientOperationId })
    expect(parsed.clientOperationId).toBe(clientOperationId)
    expect(parseAgentSessionOperationTimestamp(parsed.clientOperationId)).toBe(timestamp)
  })

  it.each([
    '33333333-3333-4333-8333-333333333333',
    '179555000000-33333333333343338333333333333333',
    '17955500000000-33333333333343338333333333333333',
    '1795550000000-ABCDEF01234546789ABCDEF012345678',
    '1795550000000-3333333333334333833333333333333g'
  ])('rejects operation ids the host cannot admit: %s', (clientOperationId) => {
    expect(parseAgentSessionOperationTimestamp(clientOperationId)).toBeNull()
    expect(() => parseAgentRequestAnswerFile({ ...answerFile(), clientOperationId })).toThrow()
  })

  it.each([MAX_BYTES, MAX_BYTES + 1])('enforces the byte boundary at %i bytes', async (size) => {
    await withAnswerBytes(paddedAnswer(size), async (path) => {
      if (size === MAX_BYTES) {
        expect(await readAgentRequestAnswerFile(path)).toEqual(answerFile())
      } else {
        await expect(readAgentRequestAnswerFile(path)).rejects.toMatchObject({
          code: 'invalid_argument'
        })
      }
    })
  })

  it('caps reads after handle stat underreports a growing file and closes the handle', async () => {
    await withAnswerBytes(paddedAnswer(MAX_BYTES * 2), async (path) => {
      const handle = await open(path, 'r')
      const stats = await handle.stat()
      stats.size = 1
      vi.spyOn(handle, 'stat').mockResolvedValue(stats)
      const read = vi.spyOn(handle, 'read')
      const close = vi.spyOn(handle, 'close')
      vi.mocked(fs.open).mockResolvedValueOnce(handle)
      await expect(readAgentRequestAnswerFile(path)).rejects.toMatchObject({
        code: 'invalid_argument'
      })
      let bytesRead = 0
      for (const result of read.mock.results) {
        if (result.type === 'return') {
          bytesRead += (await result.value).bytesRead
        }
      }
      expect(bytesRead).toBe(MAX_BYTES + 1)
      expect(close).toHaveBeenCalledOnce()
    })
  })

  it('continues after short reads through EOF on the same handle', async () => {
    await withAnswerBytes(Buffer.from(JSON.stringify(answerFile())), async (path) => {
      const handle = await open(path, 'r')
      const originalRead = handle.read.bind(handle)
      const read = vi.spyOn(handle, 'read').mockImplementation(async (...args: unknown[]) => {
        const [buffer, offset, length, position] = args
        if (
          Buffer.isBuffer(buffer) &&
          typeof offset === 'number' &&
          typeof length === 'number' &&
          (typeof position === 'number' || position === null)
        ) {
          return originalRead(buffer, offset, Math.min(length, 17), position)
        }
        throw new Error('Unexpected read signature')
      })
      const close = vi.spyOn(handle, 'close')
      vi.mocked(fs.open).mockResolvedValueOnce(handle)
      expect(await readAgentRequestAnswerFile(path)).toEqual(answerFile())
      expect(read.mock.calls.length).toBeGreaterThan(2)
      expect(close).toHaveBeenCalledOnce()
    })
  })

  it('rejects a nonregular file before reading its contents', async () => {
    await withAnswerBytes(Buffer.alloc(0), async (path) => {
      await expect(readAgentRequestAnswerFile(dirname(path))).rejects.toMatchObject({
        code: 'invalid_argument'
      })
    })
  })
})
