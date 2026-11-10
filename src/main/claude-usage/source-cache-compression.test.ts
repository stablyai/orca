import { gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import {
  compressClaudeUsageSourceText,
  decodeClaudeUsageSourceText
} from './source-cache-compression'

const source = JSON.stringify({ sources: ['Unicode: 日本語 🌊'.repeat(10_000)] })

it('keeps small and existing plain caches readable without changing them', async () => {
  const small = '{"schemaVersion":7,"sources":[]}'
  expect(await compressClaudeUsageSourceText(small)).toBe(small)
  expect(await decodeClaudeUsageSourceText(Buffer.from(small))).toBe(small)
  expect(await decodeClaudeUsageSourceText(source)).toBe(source)
})

it.each([0, 70_001, 129 * 1024 * 1024])(
  'rejects inconsistent or excessive decoded length %i',
  async (declared) => {
    const saved = gzipSync('x'.repeat(70_000))
    saved.writeUInt32LE(declared, saved.length - 4)
    await expect(decodeClaudeUsageSourceText(saved)).rejects.toThrow()
  }
)

it('bounds decompression to a forged smaller length', async () => {
  const saved = gzipSync('x'.repeat(500_000))
  saved.writeUInt32LE(70_000, saved.length - 4)
  await expect(decodeClaudeUsageSourceText(saved)).rejects.toThrow()
})

it('rejects concatenated streams rather than accepting a partial generation', async () => {
  const first = gzipSync('x'.repeat(70_000))
  const second = gzipSync('y'.repeat(70_000))
  await expect(decodeClaudeUsageSourceText(Buffer.concat([first, second]))).rejects.toThrow()
})
