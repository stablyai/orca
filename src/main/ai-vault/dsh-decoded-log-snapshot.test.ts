import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { readDshDecodedLogSnapshot, MAX_DSH_LOG_SNAPSHOT_BYTES } from './dsh-decoded-log-snapshot'

const path = '/host/.dsh/sessions/project/session-proof/session.v4.jsonl.zstd'
async function* bytes(content: Buffer) {
  yield content
}

describe('bounded decoded DSH Open log/export', () => {
  it('keeps all independently compressed records in a text snapshot', async () => {
    const source = Buffer.concat(
      ['{"type":"session"}\n', '{"type":"user/message"}\n'].map((line) =>
        zstdCompressSync(Buffer.from(line))
      )
    )
    expect(await readDshDecodedLogSnapshot(path, bytes(source))).toEqual({
      content: '{"type":"session"}\n{"type":"user/message"}\n',
      isBinary: false,
      decodedDshHistory: true
    })
  })
  it('rejects compressed and decoded budgets instead of silently exporting a prefix', async () => {
    const oversized = zstdCompressSync(Buffer.from(`${'x'.repeat(MAX_DSH_LOG_SNAPSHOT_BYTES)}\n`))
    await expect(readDshDecodedLogSnapshot(path, bytes(oversized))).rejects.toThrow('2 MiB')
    await expect(
      readDshDecodedLogSnapshot(path, bytes(Buffer.alloc(33 * 1024 * 1024)))
    ).rejects.toThrow('source read limit')
  })
  it('refuses truncated/corrupt frames and noncanonical paths', async () => {
    const compressed = zstdCompressSync(Buffer.from('{"ok":true}\n'))
    await expect(
      readDshDecodedLogSnapshot(path, bytes(compressed.subarray(0, -1)))
    ).rejects.toThrow('Truncated')
    const corrupt = Buffer.from(compressed)
    corrupt[0] = 0
    await expect(readDshDecodedLogSnapshot(path, bytes(corrupt))).rejects.toThrow('magic')
    await expect(
      readDshDecodedLogSnapshot('/host/archive.zstd', bytes(compressed))
    ).rejects.toThrow('canonical')
  })
  it('drops an uncommitted plaintext tail and preserves a WSL source address', async () => {
    const path =
      '\\\\wsl.localhost\\Ubuntu\\home\\proof\\.dsh\\sessions\\project\\session-proof\\session.v4.jsonl'
    expect(
      await readDshDecodedLogSnapshot(path, bytes(Buffer.from('{"saved":true}\n{"torn":')))
    ).toMatchObject({ content: '{"saved":true}\n', decodedDshHistory: true })
  })
})
