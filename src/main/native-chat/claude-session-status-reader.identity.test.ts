import { describe, expect, it, vi } from 'vitest'

// Inode numbers past 2^53 cannot be made on a real disk, so the reader gets fake file handles.
const disk = vi.hoisted(() => ({ content: '', ino: 0n }))

vi.mock('node:fs/promises', () => ({
  open: async () => {
    const bytes = Buffer.from(disk.content)
    const ino = disk.ino
    return {
      stat: async (options?: { bigint?: boolean }) =>
        options?.bigint
          ? { size: BigInt(bytes.length), dev: 1n, ino }
          : { size: bytes.length, dev: 1, ino: Number(ino) },
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = bytes.copy(
          buffer,
          offset,
          position,
          Math.min(bytes.length, position + length)
        )
        return { bytesRead, buffer }
      },
      close: async () => {}
    }
  }
}))

import { createClaudeSessionStatusReader } from './claude-session-status-reader'

const COMPACT = JSON.stringify({ type: 'system', subtype: 'compact_boundary' })
const REPLY = JSON.stringify({
  type: 'assistant',
  message: {
    model: 'claude-opus-5-5',
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 500,
      output_tokens: 1
    }
  }
})

describe('createClaudeSessionStatusReader file identity', () => {
  it('tells apart files whose inode numbers differ only past 2^53', async () => {
    const reader = createClaudeSessionStatusReader()
    disk.content = `${COMPACT}\n${COMPACT}\n${COMPACT}\n`
    disk.ino = 2n ** 53n
    expect(await reader.read('/session.jsonl')).toMatchObject({ compactions: 3 })
    disk.content = `${REPLY}\n${REPLY}\n`
    disk.ino = 2n ** 53n + 1n
    expect(await reader.read('/session.jsonl')).toMatchObject({ compactions: 0, usedTokens: 500 })
  })
})
