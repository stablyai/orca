import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_USAGE_HISTORY_JSONL_LINE_BYTES,
  UsageHistoryJsonlLineCapacityError,
  readUsageHistoryJsonlLines
} from './usage-history-jsonl-reader'

describe('readUsageHistoryJsonlLines', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
    )
  })

  async function createPath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'orca-usage-jsonl-'))
    temporaryDirectories.push(directory)
    return join(directory, 'history.jsonl')
  }

  it('preserves ordinary empty, CRLF, and unterminated records', async () => {
    const filePath = await createPath()
    await writeFile(filePath, 'first\r\n\nlast')

    const lines: string[] = []
    for await (const line of readUsageHistoryJsonlLines(filePath)) {
      lines.push(line)
    }

    expect(lines).toEqual(['first', '', 'last'])
  })

  it('accepts a record exactly at the byte limit', async () => {
    const filePath = await createPath()
    await writeFile(filePath, Buffer.alloc(MAX_USAGE_HISTORY_JSONL_LINE_BYTES, 0x61))

    const lines: string[] = []
    for await (const line of readUsageHistoryJsonlLines(filePath)) {
      lines.push(line)
    }

    expect(Buffer.byteLength(lines[0])).toBe(MAX_USAGE_HISTORY_JSONL_LINE_BYTES)
  })

  it('rejects a sparse unterminated record before reading the whole file', async () => {
    const filePath = await createPath()
    await writeFile(filePath, '')
    await truncate(filePath, MAX_USAGE_HISTORY_JSONL_LINE_BYTES + 8 * 1024 * 1024)

    const consume = async (): Promise<void> => {
      for await (const _line of readUsageHistoryJsonlLines(filePath)) {
        // The oversized record is unterminated, so no line should be yielded.
      }
    }

    await expect(consume()).rejects.toThrow(UsageHistoryJsonlLineCapacityError)
  })
})
