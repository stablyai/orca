import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { companions, profile } from './journal-legacy-retirement.test-fixture'

const GB = 1024 ** 3
const disk = vi.hoisted(() => ({ free: 0 }))
const volume = () => ({ bsize: 1, bavail: disk.free, blocks: 500 * GB })
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FsPromises>()),
  statfs: async () => volume()
}))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof Fs>()),
  statfsSync: () => volume()
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

it('does not start converting when what the store still lacks would leave the disk almost full', async () => {
  const kept = await profile()
  // Above the floor, but not by the ~1.5x of the unconverted journal that converting it takes.
  disk.free = 10 * GB + 1024
  await kept.launch('1.0.1', true, undefined, undefined, false).run()
  expect(kept.ensured).toEqual([])
  expect(String(kept.errors.at(-1))).toContain('disk is almost full')

  disk.free = 100 * GB
  await kept.launch('1.0.1', true, undefined, undefined, false).run()
  expect(kept.ensured).toContain('unopened')
})
