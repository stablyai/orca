import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import type * as ReleaseModule from './managed-runtime-release'
import {
  ManagedRuntimeStartError,
  RUNTIME_RELEASE_RECEIPT,
  type ManagedRuntime,
  type ManagedRuntimePin
} from './managed-runtime-release'
import { ManagedRuntimeInstallation } from './managed-runtime-installation'
import { getTarProgram } from '../../shared/archives/zip-extractor-command'

vi.mock('./managed-runtime-release', async (importOriginal) => {
  const actual = await importOriginal<typeof ReleaseModule>()
  return { ...actual, reclaimRuntimeReleases: vi.fn(actual.reclaimRuntimeReleases) }
})

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const ARCHIVE = zipSync({ server: strToU8('server bytes') })
const roots: string[] = []
afterEach(() => Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))))

async function rig(bodies: ('hang' | 'whole')[], validate?: ManagedRuntime['validate']) {
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
  const runtime = { label: 'Agent', root: () => root, pin: () => pin, validate }
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
      program: 'server',
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

it.each([
  ['at the excerpt boundary', `${'x'.repeat(220)} ghp_${'a'.repeat(36)}`],
  ['with terminal formatting', `ghp_${'a'.repeat(18)}\u001b[0m${'a'.repeat(18)}`]
])('redacts secrets %s in a failed start diagnostic', async (_label, stderr) => {
  const { root, host, phase } = await rig(['whole'], async () => {
    throw new ManagedRuntimeStartError('Start failed', {
      kind: 'exit',
      exit: { code: 3, signal: null, processless: false },
      stderr
    })
  })
  const installation = host()
  installation.install()
  await vi.waitFor(async () => expect(await phase(installation)).toBe('failed'))
  const { operation, installedVersion } = await installation.status()
  expect(operation?.error).toContain('It exited with code 3:')
  expect(operation?.error).not.toContain('ghp_')
  expect(installedVersion).toBeNull()
  expect(await readdir(root)).toEqual([])
})

const BINARY = 'binary bytes'
it.each([
  {
    archiveSha256: sha256(BINARY),
    members: [{ path: 'agent', sha256: sha256(BINARY), bytes: 12 }]
  },
  {
    archiveSha512: createHash('sha512').update(BINARY).digest('hex'),
    executables: ['agent']
  }
])(
  'installs a single-file release that is only known after looking up the latest',
  async (digest) => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-install-'))
    roots.push(dataDirectory)
    const root = join(dataDirectory, 'agent-runtimes', 'agent')
    const binary = 'binary bytes'
    let latest: ManagedRuntimePin | null = null
    const runtime: ManagedRuntime = {
      label: 'Agent',
      root: () => root,
      pin: () => latest,
      refreshPin: async () => {
        latest = {
          version: '2.0',
          url: 'https://example.test/2.0/agent',
          archiveBytes: 12,
          format: 'file',
          ...digest
        }
      }
    }
    const installation = new ManagedRuntimeInstallation('agent', runtime, {
      dataDirectory,
      program: 'server',
      findExternal: async () => false,
      fence: (work) => work(),
      fetcher: async () => new Response(binary)
    })
    installation.install()
    await vi.waitFor(async () =>
      expect((await installation.status()).operation?.phase).toBe('succeeded')
    )
    expect(await installation.status()).toMatchObject({
      installedVersion: '2.0',
      installedCurrent: true
    })
    expect(await readFile(join(root, '2.0', 'agent'), 'utf8')).toBe(binary)
  }
)

it('updates only an installed copy that is behind, keeping the release running chats may use', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-install-'))
  roots.push(dataDirectory)
  const root = join(dataDirectory, 'agent-runtimes', 'agent')
  let version = '1.0'
  const binary = (v: string) => `binary ${v}`
  const pinFor = (v: string): ManagedRuntimePin => ({
    version: v,
    url: `https://example.test/${v}/agent`,
    archiveSha256: sha256(binary(v)),
    archiveBytes: binary(v).length,
    format: 'file',
    members: [{ path: 'agent', sha256: sha256(binary(v)), bytes: binary(v).length }]
  })
  const runtime: ManagedRuntime = {
    label: 'Agent',
    root: () => root,
    pin: () => pinFor(version),
    refreshPin: async () => {}
  }
  const installation = new ManagedRuntimeInstallation('agent', runtime, {
    dataDirectory,
    program: 'server',
    findExternal: async () => false,
    fence: (work) => work(),
    fetcher: async (url) => new Response(binary(new URL(url).pathname.split('/')[1] ?? ''))
  })
  const settled = () =>
    vi.waitFor(async () => {
      const { operation } = await installation.status(false)
      expect(operation === null || operation.phase === 'succeeded').toBe(true)
    })

  await installation.updateIfBehind()
  expect(await installation.status()).toMatchObject({ installedVersion: null, operation: null })

  installation.install()
  await settled()
  version = '2.0'
  await installation.updateIfBehind()
  await settled()
  expect(await installation.status()).toMatchObject({
    installedVersion: '2.0',
    installedCurrent: true,
    updatesAutomatically: true
  })
  expect((await readdir(root)).sort()).toEqual(['1.0', '2.0'])

  version = '3.0'
  await installation.updateIfBehind()
  await settled()
  expect((await readdir(root)).sort()).toEqual(['2.0', '3.0'])
})

it.each([
  { executables: ['bin/agent'], installedVersion: '3.0' },
  { executables: ['bin/agent', 'bin/helper'], installedVersion: null }
])(
  'installs a tar.gz package only when it has every required executable: $executables',
  async ({ executables, installedVersion }) => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-install-'))
    roots.push(dataDirectory)
    const packed = join(dataDirectory, 'packed')
    await mkdir(join(packed, 'bin'), { recursive: true })
    await mkdir(join(packed, 'share'))
    await writeFile(join(packed, 'bin', 'agent'), 'agent bytes', { mode: 0o755 })
    await writeFile(join(packed, 'share', 'notes.txt'), 'notes')
    const archivePath = join(dataDirectory, 'agent.tar.gz')
    const packing = await runProcess({
      program: getTarProgram(),
      args: ['-czf', archivePath, '-C', packed, 'bin', 'share']
    })
    expect(packing.code).toBe(0)
    const archive = await readFile(archivePath)
    const root = join(dataDirectory, 'agent-runtimes', 'agent')
    const runtime: ManagedRuntime = {
      label: 'Agent',
      root: () => root,
      pin: () => ({
        version: '3.0',
        url: 'https://example.test/3.0/agent.tar.gz',
        archiveSha256: sha256(archive),
        archiveBytes: archive.length,
        format: 'tar.gz',
        executables
      })
    }
    const installation = new ManagedRuntimeInstallation('agent', runtime, {
      dataDirectory,
      program: 'server',
      findExternal: async () => false,
      fence: (work) => work(),
      fetcher: async () => new Response(archive)
    })
    installation.install()
    await vi.waitFor(
      async () =>
        expect(['succeeded', 'failed']).toContain((await installation.status()).operation?.phase),
      { timeout: 10_000 }
    )
    expect(await installation.status()).toMatchObject({ installedVersion })
    if (installedVersion) {
      expect(await readFile(join(root, '3.0', 'share', 'notes.txt'), 'utf8')).toBe('notes')
    }
  }
)

it.each([
  { digest: 'published', installedVersion: '1.0' },
  { digest: 'other', installedVersion: null }
])(
  'installs a package hashed only by sha512 when it matches, checking the command prepare unpacks: $digest',
  async ({ digest, installedVersion }) => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-install-'))
    roots.push(dataDirectory)
    const packed = join(dataDirectory, 'packed')
    await mkdir(join(packed, 'package'), { recursive: true })
    await writeFile(join(packed, 'package', 'agent.packed'), 'agent bytes')
    const archivePath = join(dataDirectory, 'agent.tgz')
    const packing = await runProcess({
      program: getTarProgram(),
      args: ['-czf', archivePath, '-C', packed, 'package']
    })
    expect(packing.code).toBe(0)
    const archive = await readFile(archivePath)
    const root = join(dataDirectory, 'agent-runtimes', 'agent')
    const runtime: ManagedRuntime = {
      label: 'Agent',
      root: () => root,
      pin: () => ({
        version: '1.0',
        url: 'https://example.test/agent-1.0.tgz',
        archiveSha512: createHash('sha512')
          .update(digest === 'published' ? archive : 'other bytes')
          .digest('hex'),
        archiveBytes: archive.length,
        format: 'tar.gz',
        executables: ['bin/agent']
      }),
      prepare: async (folder) => {
        await mkdir(join(folder, 'bin'))
        await writeFile(
          join(folder, 'bin', 'agent'),
          await readFile(join(folder, 'package', 'agent.packed'))
        )
      }
    }
    const installation = new ManagedRuntimeInstallation('agent', runtime, {
      dataDirectory,
      program: 'server',
      findExternal: async () => false,
      fence: (work) => work(),
      fetcher: async () => new Response(archive)
    })
    installation.install()
    await vi.waitFor(
      async () =>
        expect(['succeeded', 'failed']).toContain((await installation.status()).operation?.phase),
      { timeout: 10_000 }
    )
    expect(await installation.status()).toMatchObject({ installedVersion })
    if (installedVersion) {
      expect(await readFile(join(root, '1.0', 'bin', 'agent'), 'utf8')).toBe('agent bytes')
    }
  }
)

it('never looks up the latest release for a copy that is not installed', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-install-'))
  roots.push(dataDirectory)
  const refreshPin = vi.fn(async () => {})
  const fetcher = vi.fn(async () => new Response(''))
  const installation = new ManagedRuntimeInstallation(
    'agent',
    {
      label: 'Agent',
      root: () => join(dataDirectory, 'agent-runtimes', 'agent'),
      pin: () => null,
      refreshPin
    },
    {
      dataDirectory,
      program: 'cli',
      findExternal: async () => false,
      fence: (work) => work(),
      fetcher
    }
  )

  await installation.updateIfBehind()

  expect(refreshPin).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
})
