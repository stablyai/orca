import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import type * as ReleaseModule from './managed-runtime-release'
import { RUNTIME_RELEASE_RECEIPT } from './managed-runtime-release'
import { ManagedRuntimeInstallation } from './managed-runtime-installation'

vi.mock('./managed-runtime-release', async (importOriginal) => {
  const actual = await importOriginal<typeof ReleaseModule>()
  return { ...actual, reclaimRuntimeReleases: vi.fn(actual.reclaimRuntimeReleases) }
})

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const ARCHIVE = zipSync({ server: strToU8('server bytes') })
const roots: string[] = []
afterEach(() => Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))))

async function rig(bodies: ('hang' | 'whole')[]) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-install-'))
  roots.push(dataDirectory)
  const root = join(dataDirectory, 'agent-runtimes', 'agent')
  const pin = {
    version: '1.0',
    url: 'https://example.test/agent-1.0.zip',
    archiveSha256: sha256(ARCHIVE),
    archiveBytes: ARCHIVE.length,
    members: [{ path: 'server', sha256: sha256('server bytes'), bytes: 12 }]
  }
  const runtime = { label: 'Agent', root: () => root, pin: () => pin }
  const fetcher = async () => {
    const body = bodies.shift()
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(ARCHIVE.slice(0, 5))
          if (body === 'whole') {
            controller.enqueue(ARCHIVE.slice(5))
            controller.close()
          }
        }
      })
    )
  }
  const host = () =>
    new ManagedRuntimeInstallation('agent', runtime, {
      dataDirectory,
      findExternal: async () => false,
      fence: (work) => work(),
      fetcher
    })
  const phase = async (installation: ManagedRuntimeInstallation) =>
    (await installation.status()).operation?.phase
  return { root, host, phase }
}

it('installs only when asked, with progress, cancel, retry, and a status read from disk', async () => {
  const { root, host, phase } = await rig(['hang', 'whole'])
  const installation = host()
  expect(await installation.status()).toMatchObject({ installedVersion: null, source: null })
  const started = installation.install()
  await vi.waitFor(async () =>
    expect((await installation.status()).operation?.downloadedBytes).toBe(5)
  )
  expect(installation.install().id).toBe(started.id)
  expect(await installation.cancel(started.id)).toMatchObject({ phase: 'cancelled' })
  expect(await readdir(root)).toEqual([])

  expect(installation.install().id).not.toBe(started.id)
  await vi.waitFor(async () => expect(await phase(installation)).toBe('succeeded'))
  expect(await host().status()).toMatchObject({
    installedVersion: '1.0',
    installedCurrent: true,
    source: 'managed',
    operation: null
  })
  expect(await readdir(root)).toEqual(['1.0'])

  await rm(join(root, '1.0', RUNTIME_RELEASE_RECEIPT))
  expect(await installation.status()).toMatchObject({ damaged: true })
  const rewrite = installation.install()
  await vi.waitFor(async () =>
    expect((await installation.status()).operation).toMatchObject({
      id: rewrite.id,
      phase: 'succeeded'
    })
  )
  expect(await installation.status()).toMatchObject({ installedCurrent: true })
})

it('repairs a damaged copy when Install is clicked again', async () => {
  const { root, host, phase } = await rig(['whole', 'whole'])
  const installation = host()
  installation.install()
  await vi.waitFor(async () => expect(await phase(installation)).toBe('succeeded'))
  await writeFile(join(root, '1.0', 'server'), 'cut')
  expect(await installation.status()).toMatchObject({
    installedVersion: null,
    damaged: true,
    canRemove: true
  })

  installation.install()
  await vi.waitFor(async () => expect(await phase(installation)).toBe('succeeded'))
  const repaired = await installation.status()
  expect(repaired).toMatchObject({ installedVersion: '1.0', installedCurrent: true })
  expect(repaired.damaged).toBeUndefined()
  expect(await readdir(root)).toEqual(['1.0'])
})
