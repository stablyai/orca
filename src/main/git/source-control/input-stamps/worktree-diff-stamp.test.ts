import type * as fs from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { readHostFilesStamp } from './worktree-diff-stamp'

const { stat } = vi.hoisted(() => ({ stat: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  stat
}))

it('invalidates a file stamp after a same-size rewrite with a preserved mtime', async () => {
  const metadata = { mtimeMs: 1_000, size: 5, ino: 42 }
  stat
    .mockResolvedValueOnce({ ...metadata, ctimeMs: 2_000 })
    .mockResolvedValueOnce({ ...metadata, ctimeMs: 3_000 })

  const before = await readHostFilesStamp(['sample.txt'])
  const after = await readHostFilesStamp(['sample.txt'])

  expect(after?.value).not.toBe(before?.value)
  expect(after).toMatchObject({ newestTimestampMs: 3_000 })
})
