import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type { ManagedRuntimePin } from './managed-runtime-release'

// Endpoint security briefly locks a release Orca just ran, so publishing it is refused at first.
const locked = vi.hoisted(() => ({
  renames: 0,
  onRefused: () => {},
  backoff: async (_signal?: AbortSignal) => {}
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (basename(from) === 'release' && locked.renames > 0) {
        locked.renames -= 1
        locked.onRefused()
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), {
          code: 'EPERM'
        })
      }
      return actual.rename(from, to)
    }
  }
})

vi.mock('node:timers/promises', () => ({
  setTimeout: (_ms: number, _value: unknown, options?: { signal?: AbortSignal }) =>
    locked.backoff(options?.signal)
}))

const { installRuntimeRelease } = await import('./managed-runtime-release-install')
const { resolveInstalledRuntimeRelease } = await import('./managed-runtime-release')

const bytes = Buffer.from('server 1.5.2')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const pin: ManagedRuntimePin = {
  version: '1.5.2',
  url: 'https://downloads.invalid/server-1.5.2',
  archiveSha256: sha256,
  archiveBytes: bytes.length,
  format: 'file',
  members: [{ path: 'server', sha256, bytes: bytes.length }]
}

const platform = process.platform
let root: string
const commit = vi.fn()
beforeEach(async () => {
  locked.renames = 0
  locked.onRefused = () => {}
  locked.backoff = async () => {}
  commit.mockReset()
  root = await mkdtemp(join(tmpdir(), 'orca-runtime-publish-'))
})
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: platform })
  await rm(root, { recursive: true, force: true })
})

function install(signal = new AbortController().signal) {
  return installRuntimeRelease({
    agent: 'server-agent',
    runtime: { label: 'Server' },
    root,
    pin,
    fetcher: async () => new Response(new Uint8Array(bytes)),
    signal,
    publish: () => {},
    commit
  })
}

it('publishes on Windows once a scanner releases the just-run copy', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  locked.renames = 10
  await install()
  expect(resolveInstalledRuntimeRelease(root, pin).release?.current).toBe(true)
  expect(await readdir(root)).toEqual(['1.5.2'])
})

it('still fails on Windows when the copy stays locked', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  locked.renames = Infinity
  await expect(install()).rejects.toMatchObject({ code: 'EPERM' })
  expect(await readdir(root)).toEqual([])
})

it('stops retrying and does not commit once the install is cancelled', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const controller = new AbortController()
  locked.renames = 10
  locked.onRefused = () => controller.abort()
  await expect(install(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(locked.renames).toBe(9)
  expect(commit).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('cancels during the backoff wait without waiting it out', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const controller = new AbortController()
  locked.renames = 10
  locked.backoff = (signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason))
      controller.abort()
    })
  await expect(install(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(locked.renames).toBe(9)
  expect(commit).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('does not retry a refused publication off Windows', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  locked.renames = 1
  await expect(install()).rejects.toMatchObject({ code: 'EPERM' })
  expect(await readdir(root)).toEqual([])
})
