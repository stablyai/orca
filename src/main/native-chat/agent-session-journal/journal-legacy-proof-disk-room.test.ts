import type * as FsPromises from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { companions, profile } from './journal-legacy-retirement.test-fixture'

const GB = 1024 ** 3
const disk = vi.hoisted(() => ({ free: 0 }))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FsPromises>()),
  statfs: async () => ({ bsize: 4096, bavail: disk.free / 4096, blocks: (500 * GB) / 4096 })
}))

it('waits to convert old chats while the disk is almost full, then proves once there is room', async () => {
  const kept = await profile()
  const keeps = () => kept.launch('1.0.1', true, undefined, undefined, false)
  disk.free = 2 * GB
  const legacyProof = vi.spyOn(kept.readers, 'legacyProof')
  await keeps().run()
  expect(legacyProof).not.toHaveBeenCalled()
  expect(String(kept.errors.at(-1))).toContain('disk is almost full')
  expect(companions(kept.filename)).toContain(kept.filename)

  disk.free = 100 * GB
  await keeps().run()
  expect(legacyProof).toHaveBeenCalled()
})
