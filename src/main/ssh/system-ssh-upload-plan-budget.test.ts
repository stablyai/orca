import type * as FsPromises from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
const { directory, stats } = vi.hoisted(() => ({ directory: vi.fn(), stats: vi.fn() }))
vi.mock('node:fs/promises', async (load) => ({
  ...(await load<typeof FsPromises>()),
  opendir: directory,
  lstat: stats
}))
import { collectLocalUploadPlan } from './system-ssh-file-transfer'
import { getRemoteHostPlatform } from './ssh-remote-platform'

it('stops the upload producer at its retained-plan ceiling before any transfer starts', async () => {
  let visited = 0
  let closed = false
  stats.mockResolvedValue({
    isSymbolicLink: () => false,
    isFile: () => true,
    isDirectory: () => false
  })
  directory.mockImplementation(async () =>
    (async function* () {
      try {
        for (let index = 0; index < 1_000_000; index++) {
          visited++
          yield { name: `file-${index}.txt` }
        }
      } finally {
        closed = true
      }
    })()
  )
  await expect(
    collectLocalUploadPlan('/local', 'C:/remote', getRemoteHostPlatform('win32-x64'), undefined)
  ).rejects.toThrow('transfer plan is too large')
  expect(visited).toBeLessThanOrEqual(100_000)
  expect(closed).toBe(true)
})

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
