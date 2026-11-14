import type * as FsPromises from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
const { directory, stats } = vi.hoisted(() => ({ directory: vi.fn(), stats: vi.fn() }))
vi.mock('node:fs/promises', async (load) => ({
  ...(await load<typeof FsPromises>()),
  opendir: directory,
  lstat: stats
}))
import { collectLocalUploadPlan } from './system-ssh-file-transfer'
import { getRemoteHostPlatform } from '../../remote-host/ssh-remote-platform'

it('closes an in-progress upload directory when canceled', async () => {
  const controller = new AbortController()
  let closed = false
  directory.mockImplementation(async () =>
    (async function* () {
      try {
        controller.abort(new Error('canceled'))
        yield { name: 'file' }
      } finally {
        closed = true
      }
    })()
  )
  await expect(
    collectLocalUploadPlan(
      '/local',
      'C:/remote',
      getRemoteHostPlatform('win32-x64'),
      controller.signal
    )
  ).rejects.toThrow('cancelled')
  expect(closed).toBe(true)
})
