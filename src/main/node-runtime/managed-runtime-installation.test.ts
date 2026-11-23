import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ManagedRuntimeInstallation } from './managed-runtime-installation'
import {
  resolveInstalledRuntimeRelease,
  writeRuntimeReleaseReceipt,
  type ManagedRuntime,
  type ManagedRuntimePin
} from './managed-runtime-release'

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

function serverPin(version: string): { pin: ManagedRuntimePin; bytes: Buffer } {
  const bytes = Buffer.from(`#!/bin/sh\n# server ${version}\n`)
  return {
    bytes,
    pin: {
      version,
      url: `https://downloads.invalid/server-${version}`,
      archiveSha256: sha256(bytes),
      archiveBytes: bytes.length,
      format: 'file',
      members: [{ path: 'server', sha256: sha256(bytes), bytes: bytes.length }]
    }
  }
}

const PINNED = serverPin('1.5.2')
const OLD = serverPin('1.5.0')

let data: string
let root: string

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), 'orca-runtime-autoupdate-'))
  root = join(data, 'agent-runtimes', 'server')
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(data, { recursive: true, force: true })
})

/** An Orca-published release, as an earlier build's Install left it. */
async function seedRelease({ pin, bytes }: { pin: ManagedRuntimePin; bytes: Buffer }) {
  const folder = join(root, pin.version)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'server'), bytes)
  await chmod(join(folder, 'server'), 0o755)
  await writeRuntimeReleaseReceipt(folder, pin)
}

function runtime(overrides: Partial<ManagedRuntime> = {}): ManagedRuntime {
  return {
    label: 'Server',
    root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'server'),
    pin: () => PINNED.pin,
    updatesToPin: true,
    ...overrides
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

function serve(bytes: Buffer = PINNED.bytes) {
  return vi.fn<Fetch>(async () => new Response(new Uint8Array(bytes)))
}

function installation(
  fetcher: Fetch,
  options: { runtime?: ManagedRuntime; updatesEnabled?: () => boolean } = {}
) {
  return new ManagedRuntimeInstallation('server-agent', options.runtime ?? runtime(), {
    dataDirectory: data,
    program: 'server',
    findExternal: async () => false,
    fence: (work) => work(),
    fetcher,
    ...(options.updatesEnabled ? { updatesEnabled: options.updatesEnabled } : {})
  })
}

async function settled(subject: ManagedRuntimeInstallation) {
  await vi.waitFor(async () => {
    const phase = (await subject.status(false)).operation?.phase
    expect(['succeeded', 'failed', 'cancelled']).toContain(phase)
  })
  return subject.status(false)
}

const launches = () => resolveInstalledRuntimeRelease(root, PINNED.pin).release

it('updates an older Orca install to the pinned release without a click', async () => {
  await seedRelease(OLD)
  const fetcher = serve()
  const subject = installation(fetcher)
  await subject.updateIfBehind()
  const state = await settled(subject)
  expect(state.operation?.phase).toBe('succeeded')
  expect(state).toMatchObject({ installedVersion: '1.5.2', installedCurrent: true })
  expect(launches()).toMatchObject({ version: '1.5.2', current: true })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps the release running chats use until Orca next starts', async () => {
  await seedRelease(OLD)
  const subject = installation(serve())
  await subject.updateIfBehind()
  await settled(subject)
  // A chat started before the update still runs 1.5.0 from its folder.
  expect(await readFile(join(root, '1.5.0', 'server'))).toEqual(OLD.bytes)
  // The next start reclaims it, since launches now resolve to 1.5.2.
  installation(serve())
  await vi.waitFor(() => expect(existsSync(join(root, '1.5.0'))).toBe(false))
  expect(await readdir(root)).toEqual(['1.5.2'])
})

it('leaves sign-in files beside the releases untouched', async () => {
  await seedRelease(OLD)
  const tokens = join(data, 'antigravity-chat', 'antigravity-acp')
  await mkdir(tokens, { recursive: true })
  const files = ['oauth_token.json', 'google_accounts.json']
  for (const name of files) {
    await writeFile(join(tokens, name), `{"token":"${name}"}`)
  }
  const read = () =>
    Promise.all(
      files.map(async (name) => {
        const path = join(tokens, name)
        return { hash: sha256(await readFile(path)), mtime: (await stat(path)).mtimeMs }
      })
    )
  const before = await read()
  const subject = installation(serve())
  await subject.updateIfBehind()
  expect((await settled(subject)).operation?.phase).toBe('succeeded')
  expect(await read()).toEqual(before)
})

it('does not update again once the pinned release is installed', async () => {
  await seedRelease(OLD)
  const fetcher = serve()
  const subject = installation(fetcher)
  await subject.updateIfBehind()
  await settled(subject)
  await subject.updateIfBehind()
  await installation(fetcher).updateIfBehind()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps the older release on failure and backs off before retrying', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await seedRelease(OLD)
  // A download that doesn't match its pinned checksum fails without network retries.
  const fetcher = serve(Buffer.from('not the pinned server'))
  const subject = installation(fetcher)
  await subject.updateIfBehind()
  const failed = await settled(subject)
  expect(failed.operation).toMatchObject({ phase: 'failed' })
  expect(failed.operation?.error).toMatch(/didn't match/)
  // Settings still offers Update on the copy chats keep running.
  expect(failed).toMatchObject({ installedVersion: '1.5.0', installedCurrent: false })
  expect(launches()).toMatchObject({ version: '1.5.0', current: false })
  expect(await readdir(root)).toEqual(['1.5.0'])

  await subject.updateIfBehind()
  vi.setSystemTime(Date.now() + 59 * 60_000)
  await subject.updateIfBehind()
  expect(fetcher).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.now() + 2 * 60_000)
  await subject.updateIfBehind()
  await settled(subject)
  expect(fetcher).toHaveBeenCalledTimes(2)
  // The second failure waits two hours.
  vi.setSystemTime(Date.now() + 90 * 60_000)
  await subject.updateIfBehind()
  expect(fetcher).toHaveBeenCalledTimes(2)
  vi.setSystemTime(Date.now() + 31 * 60_000)
  await subject.updateIfBehind()
  await settled(subject)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('honors the kill switch', async () => {
  await seedRelease(OLD)
  const fetcher = serve()
  await installation(fetcher, { updatesEnabled: () => false }).updateIfBehind()
  expect(fetcher).not.toHaveBeenCalled()
  expect(launches()).toMatchObject({ version: '1.5.0' })
})

it('installs nothing where Orca has no release', async () => {
  const fetcher = serve()
  await installation(fetcher).updateIfBehind()
  expect(fetcher).not.toHaveBeenCalled()
  expect(existsSync(root)).toBe(false)
})

it('never downgrades a newer release', async () => {
  await seedRelease(serverPin('1.6.0'))
  const fetcher = serve()
  await installation(fetcher).updateIfBehind()
  expect(fetcher).not.toHaveBeenCalled()
})

it('leaves runtimes that do not follow their pin to Update', async () => {
  await seedRelease(OLD)
  const fetcher = serve()
  await installation(fetcher, { runtime: runtime({ updatesToPin: undefined }) }).updateIfBehind()
  expect(fetcher).not.toHaveBeenCalled()
})

it('treats a Cancel as declining that release until Orca next starts', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await seedRelease(OLD)
  const { promise: held, resolve: release } = Promise.withResolvers<void>()
  const fetcher = vi.fn<Fetch>(async (_url, init) => {
    await held
    init?.signal?.throwIfAborted()
    return new Response(new Uint8Array(PINNED.bytes))
  })
  const subject = installation(fetcher)
  await subject.updateIfBehind()
  const running = await subject.status(false)
  const cancelled = subject.cancel(running.operation?.id ?? '')
  release()
  expect((await cancelled)?.phase).toBe('cancelled')
  vi.setSystemTime(Date.now() + 48 * 60 * 60_000)
  await subject.updateIfBehind()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(launches()).toMatchObject({ version: '1.5.0' })
})
