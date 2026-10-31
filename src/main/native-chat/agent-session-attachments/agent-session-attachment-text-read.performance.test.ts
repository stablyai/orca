import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AttachmentTextSource } from '../../../shared/attachment-text-source'
import { readAttachmentTextChunk } from './agent-session-attachment-text-read'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return {
    ...original,
    open: vi.fn(original.open),
    stat: vi.fn(original.stat),
    realpath: vi.fn(original.realpath)
  }
})

it('keeps real authorized range work linear at N and 10N while exporting exact bytes', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'range35636-'))
  const folder = join(root, '12345678-1234-1234-1234-123456789abc')
  await fs.mkdir(folder)
  const path = join(folder, 'source.txt')
  try {
    for (const size of [100_000, 1_000_000]) {
      const bytes = Buffer.from('é🙂\r\n'.repeat(size / 8))
      await fs.writeFile(path, bytes)
      vi.mocked(fs.open).mockClear()
      vi.mocked(fs.stat).mockClear()
      vi.mocked(fs.realpath).mockClear()
      let ranges = 0
      const source = new AttachmentTextSource(path, (request) => {
        ranges++
        return readAttachmentTextChunk(root, request)
      })
      await source.page(0)
      await source.page(source.pageCount - 1)
      expect(await source.copyText()).toBe(bytes.toString('utf8'))
      expect(ranges).toBe(2 + Math.ceil(bytes.length / (256 * 1024)))
      expect(fs.open).toHaveBeenCalledTimes(ranges)
      expect(vi.mocked(fs.stat).mock.calls.length).toBeLessThanOrEqual(4 * ranges)
      expect(vi.mocked(fs.realpath).mock.calls.length).toBeLessThanOrEqual(8 * ranges)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
