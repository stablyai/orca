import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ManagedRuntimePin } from './managed-runtime-release'
import type * as ReleaseInstall from './managed-runtime-release-install'
import type * as FsPromises from 'node:fs/promises'

const installs = vi.hoisted((): { margin?: number }[] => [])
const disk = vi.hoisted(() => ({ unreadable: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    statfs: (...args: Parameters<typeof actual.statfs>) =>
      disk.unreadable ? Promise.reject(new Error('ENOSYS: statfs')) : actual.statfs(...args)
  }
})

vi.mock('./managed-runtime-release-install', async (importOriginal) => {
  const actual = await importOriginal<typeof ReleaseInstall>()
  return {
    ...actual,
    installRuntimeRelease: (input: Parameters<typeof actual.installRuntimeRelease>[0]) => {
      installs.push({ margin: input.automaticFreeSpaceMarginBytes })
      return actual.installRuntimeRelease(input)
    }
  }
})

const { ManagedRuntimeInstallation } = await import('./managed-runtime-installation')
const { writeRuntimeReleaseReceipt } = await import('./managed-runtime-release')
const { installRuntimeRelease } = await import('./managed-runtime-release-install')

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const pinFor = (version: string, bytes: Buffer): ManagedRuntimePin => ({
  version,
  url: `https://downloads.invalid/server-${version}`,
  archiveSha256: sha256(bytes),
  archiveBytes: bytes.length,
  format: 'file',
  members: [{ path: 'server', sha256: sha256(bytes), bytes: bytes.length }]
})
const NEW = Buffer.from('server 1.5.2')
const OLD = Buffer.from('server 1.5.0')

let data: string
beforeEach(async () => {
  installs.length = 0
  disk.unreadable = false
  data = await mkdtemp(join(tmpdir(), 'orca-runtime-space-'))
  const folder = join(data, 'agent-runtimes', 'server', '1.5.0')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'server'), OLD)
  await chmod(join(folder, 'server'), 0o755)
  await writeRuntimeReleaseReceipt(folder, pinFor('1.5.0', OLD))
})
afterEach(() => rm(data, { recursive: true, force: true }))

function subject() {
  return new ManagedRuntimeInstallation(
    'server-agent',
    {
      label: 'Server',
      root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'server'),
      pin: () => pinFor('1.5.2', NEW),
      updatesToPin: true
    },
    {
      dataDirectory: data,
      program: 'server',
      findExternal: async () => false,
      fence: (work) => work(),
      fetcher: async () => new Response(new Uint8Array(NEW))
    }
  )
}

async function settled(installation: InstanceType<typeof ManagedRuntimeInstallation>) {
  await vi.waitFor(async () =>
    expect(['succeeded', 'failed']).toContain((await installation.status(false)).operation?.phase)
  )
}

it('keeps 2 GB more free for an automatic update than for one the user started', async () => {
  const automatic = subject()
  await automatic.updateIfBehind()
  await settled(automatic)
  const manual = subject()
  manual.install()
  await settled(manual)
  expect(installs).toEqual([{ margin: 2 * 1024 ** 3 }, { margin: undefined }])
})

it('refuses an install that would leave less than its margin free', async () => {
  await expect(
    installRuntimeRelease({
      agent: 'server-agent',
      runtime: { label: 'Server' },
      root: join(data, 'agent-runtimes', 'other'),
      pin: pinFor('1.5.2', NEW),
      fetcher: async () => new Response(new Uint8Array(NEW)),
      automaticFreeSpaceMarginBytes: Number.MAX_SAFE_INTEGER,
      signal: new AbortController().signal,
      publish: () => undefined,
      commit: () => undefined
    })
  ).rejects.toThrow(
    /^Orca updates Server by itself only with \d+ MB free, and this host has \d+ MB\. Update needs \d+ MB\.$/
  )
})

it("doesn't update by itself when free space can't be read, and Update still installs", async () => {
  disk.unreadable = true
  const automatic = subject()
  await automatic.updateIfBehind()
  await settled(automatic)
  const failed = await automatic.status(false)
  expect(failed.operation?.error).toMatch(/couldn't read this host's free disk space/)
  expect(failed.installedVersion).toBe('1.5.0')
  automatic.install()
  await settled(automatic)
  expect((await automatic.status(false)).installedVersion).toBe('1.5.2')
})
