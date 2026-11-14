import { mkdtemp, readdir, rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import type * as GroupGuard from './provider-group-orphan-guard'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { publishProviderOwnership } from './provider-ownership-journal'

const state = vi.hoisted(() => ({ failWrite: true }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args)
      if (args[1] !== 'wx' || !state.failWrite) {
        return file
      }
      return {
        close: () => file.close(),
        sync: () => file.sync(),
        writeFile: async () => {
          await file.writeFile('{')
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        }
      }
    }
  }
})
vi.mock('./provider-process-row-read', () => ({
  readPosixProcessRow: async (pid: number) => ({
    pid,
    ppid: pid === 900002 ? 900001 : process.pid,
    pgid: pid === process.pid ? process.pid : 900001,
    startedAt: '1234',
    startResolution: 'clock-tick'
  })
}))
vi.mock('./provider-group-orphan-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof GroupGuard>()),
  providerGroupAbsent: () => true
}))

let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

it('removes a partial unpublished record on each failed write and allows a later launch', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-publication-'))
  const directory = join(root, 'provider-processes')
  state.failWrite = true
  for (let attempt = 0; attempt < 10; attempt++) {
    await expect(
      publishProviderOwnership(directory, 'test-boot', 900001, 900002)
    ).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await readdir(directory)).toEqual([])
  }
  state.failWrite = false
  const published = await publishProviderOwnership(directory, 'test-boot', 900001, 900002)
  expect(await readdir(directory)).toHaveLength(1)
  await published.remove()
  expect(await readdir(directory)).toEqual([])
})
