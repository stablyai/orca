import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACP_SOCKET_NAME_BUDGET,
  acpRunRootFitsSocket,
  acpShortTempRoot,
  resolveAcpTempRoot
} from './acp-temp-root'
import { acpRunFolder } from './acp-private-temp'

const posix = describe.skipIf(process.platform === 'win32')
const uid = process.getuid?.() ?? 0
const LONG_DATA_DIRECTORY = `/orca-data/${'d'.repeat(70)}`
const owned = new Set<string>()

async function shortBase(): Promise<string> {
  const base = await mkdtemp('/tmp/o')
  owned.add(base)
  return base
}

afterEach(async () => {
  await Promise.all([...owned].map((path) => rm(path, { recursive: true, force: true })))
  owned.clear()
})

describe('acpRunRootFitsSocket', () => {
  it('fits a root exactly at the macOS limit and rejects one byte more', () => {
    const atLimit = `/${'a'.repeat(34)}`
    expect(Buffer.byteLength(atLimit)).toBe(35)
    expect(acpRunRootFitsSocket(atLimit, 'darwin')).toBe(true)
    expect(acpRunRootFitsSocket(`${atLimit}a`, 'darwin')).toBe(false)
  })

  it('fits a root exactly at the Linux limit and rejects one byte more', () => {
    const atLimit = `/${'a'.repeat(38)}`
    expect(Buffer.byteLength(atLimit)).toBe(39)
    expect(acpRunRootFitsSocket(atLimit, 'linux')).toBe(true)
    expect(acpRunRootFitsSocket(`${atLimit}a`, 'linux')).toBe(false)
  })

  it('counts UTF-8 bytes, not characters', () => {
    const twoByteRoot = `/${'é'.repeat(17)}`
    expect(twoByteRoot).toHaveLength(18)
    expect(acpRunRootFitsSocket(twoByteRoot, 'darwin')).toBe(true)
    expect(acpRunRootFitsSocket(`${twoByteRoot}é`, 'darwin')).toBe(false)
  })
})

describe('acpShortTempRoot', () => {
  const dataRoot = (agent: string): string => join(LONG_DATA_DIRECTORY, 'acp-temp', agent)

  // Directory-bound Macs often have user ids of 7 to 10 digits.
  it.each([501, 999_999, 1_000_000, 1_234_567, 1_907_312_345])(
    'fits the socket budget on macOS for user id %i',
    (id) => {
      const root = acpShortTempRoot({
        shortBase: '/tmp',
        uid: id,
        dataRoot: dataRoot('antigravity')
      })
      expect(acpRunRootFitsSocket(root, 'darwin')).toBe(true)
    }
  )

  it('does not grow with the agent name', () => {
    const length = (agent: string): number =>
      Buffer.byteLength(acpShortTempRoot({ shortBase: '/tmp', uid, dataRoot: dataRoot(agent) }))
    expect(length('a'.repeat(60))).toBe(length('grok'))
  })

  it('is stable for one data root and differs between data roots and agents', () => {
    const root = (path: string): string =>
      acpShortTempRoot({ shortBase: '/tmp', uid, dataRoot: path })
    expect(root(dataRoot('grok'))).toBe(root(dataRoot('grok')))
    expect(root(dataRoot('grok'))).not.toBe(root(dataRoot('antigravity')))
    expect(root(dataRoot('grok'))).not.toBe(root(`${LONG_DATA_DIRECTORY}-other/acp-temp/grok`))
  })
})

posix('resolveAcpTempRoot', () => {
  it('keeps a root that fits inside the data folder and creates nothing in /tmp', async () => {
    const base = await shortBase()
    const root = resolveAcpTempRoot({
      dataDirectory: '/d',
      agent: 'grok',
      platform: 'darwin',
      uid,
      shortBase: base
    })
    expect(root).toBe(join('/d', 'acp-temp', 'grok'))
    await expect(stat(join(base, `oacp-${uid}`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['darwin', 'linux'] as const)(
    'moves a too-long %s root to a short private folder that fits',
    async (platform) => {
      const base = await shortBase()
      const root = resolveAcpTempRoot({
        dataDirectory: LONG_DATA_DIRECTORY,
        agent: 'grok',
        platform,
        uid,
        shortBase: base
      })
      expect(root.startsWith(join(base, `oacp-${uid}`))).toBe(true)
      expect(acpRunRootFitsSocket(root, platform)).toBe(true)
      const info = await stat(join(base, `oacp-${uid}`))
      expect(info.isDirectory()).toBe(true)
      expect(info.uid).toBe(uid)
      expect(info.mode & 0o077).toBe(0)
    }
  )

  it('lets a real socket with the full name budget bind under a run folder in the short root', async () => {
    const base = await shortBase()
    const root = resolveAcpTempRoot({
      dataDirectory: LONG_DATA_DIRECTORY,
      agent: 'grok',
      platform: process.platform,
      uid,
      shortBase: base
    })
    const folder = await acpRunFolder(root)
    const socketPath = join(folder.path, 'x'.repeat(ACP_SOCKET_NAME_BUDGET))
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(
        process.platform === 'darwin' ? 103 : 107
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await folder.remove()
    }
  })

  it('gives each agent and data folder its own short root, stable across calls', async () => {
    const base = await shortBase()
    const resolve = (dataDirectory: string, agent = 'grok'): string =>
      resolveAcpTempRoot({ dataDirectory, agent, platform: 'linux', uid, shortBase: base })
    const first = resolve(LONG_DATA_DIRECTORY)
    expect(resolve(LONG_DATA_DIRECTORY)).toBe(first)
    expect(resolve(`${LONG_DATA_DIRECTORY}-other`)).not.toBe(first)
    expect(resolve(LONG_DATA_DIRECTORY, 'antigravity')).not.toBe(first)
  })

  it('keeps a long root in the data folder on Windows, as before', async () => {
    const base = await shortBase()
    const root = resolveAcpTempRoot({
      dataDirectory: LONG_DATA_DIRECTORY,
      agent: 'grok',
      platform: 'win32',
      uid,
      shortBase: base
    })
    expect(root).toBe(join(LONG_DATA_DIRECTORY, 'acp-temp', 'grok'))
    await expect(stat(join(base, `oacp-${uid}`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the data folder when the user id is unavailable', async () => {
    const root = resolveAcpTempRoot({
      dataDirectory: LONG_DATA_DIRECTORY,
      agent: 'grok',
      platform: 'linux',
      uid: null,
      shortBase: await shortBase()
    })
    expect(root).toBe(join(LONG_DATA_DIRECTORY, 'acp-temp', 'grok'))
  })

  it('still uses a short root that misses the budget when it is shorter than the data root', async () => {
    const base = await shortBase()
    const deepBase = join(base, 'n'.repeat(20))
    await mkdir(deepBase)
    const root = resolveAcpTempRoot({
      dataDirectory: LONG_DATA_DIRECTORY,
      agent: 'grok',
      platform: 'darwin',
      uid,
      shortBase: deepBase
    })
    expect(root.startsWith(join(deepBase, `oacp-${uid}`))).toBe(true)
    expect(acpRunRootFitsSocket(root, 'darwin')).toBe(false)
    expect(Buffer.byteLength(root)).toBeLessThan(
      Buffer.byteLength(join(LONG_DATA_DIRECTORY, 'acp-temp', 'grok'))
    )
  })

  it('keeps the data folder when the short root would not be shorter', async () => {
    const base = await shortBase()
    const deepBase = join(base, 'n'.repeat(60))
    await mkdir(deepBase)
    const dataDirectory = `/orca-data/${'d'.repeat(30)}`
    const root = resolveAcpTempRoot({
      dataDirectory,
      agent: 'grok',
      platform: 'darwin',
      uid,
      shortBase: deepBase
    })
    expect(root).toBe(join(dataDirectory, 'acp-temp', 'grok'))
    await expect(stat(join(deepBase, `oacp-${uid}`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a user-owned folder that is open to others, without changing it, and warns', async () => {
    const base = await shortBase()
    const owner = join(base, `oacp-${uid}`)
    await mkdir(owner)
    await chmod(owner, 0o777)
    const logger = { warn: vi.fn(), error: vi.fn() }
    const root = resolveAcpTempRoot({
      dataDirectory: LONG_DATA_DIRECTORY,
      agent: 'grok',
      platform: 'linux',
      uid,
      shortBase: base,
      logger
    })
    expect(root).toBe(join(LONG_DATA_DIRECTORY, 'acp-temp', 'grok'))
    expect((await stat(owner)).mode & 0o777).toBe(0o777)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('refuses a short folder owned by someone else and warns', async () => {
    const base = await shortBase()
    const otherUid = uid + 1
    await mkdir(join(base, `oacp-${otherUid}`), { mode: 0o700 })
    const logger = { warn: vi.fn(), error: vi.fn() }
    const root = resolveAcpTempRoot({
      dataDirectory: LONG_DATA_DIRECTORY,
      agent: 'grok',
      platform: 'linux',
      uid: otherUid,
      shortBase: base,
      logger
    })
    expect(root).toBe(join(LONG_DATA_DIRECTORY, 'acp-temp', 'grok'))
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('refuses a short folder that is a symlink', async () => {
    const base = await shortBase()
    const target = await mkdtemp(join(base, 't'))
    await symlink(target, join(base, `oacp-${uid}`))
    const root = resolveAcpTempRoot({
      dataDirectory: LONG_DATA_DIRECTORY,
      agent: 'grok',
      platform: 'linux',
      uid,
      shortBase: base
    })
    expect(root).toBe(join(LONG_DATA_DIRECTORY, 'acp-temp', 'grok'))
  })

  it('keeps the data folder when /tmp cannot be written', () => {
    const root = resolveAcpTempRoot({
      dataDirectory: LONG_DATA_DIRECTORY,
      agent: 'grok',
      platform: 'linux',
      uid,
      // Short enough to be preferred, with a parent that does not exist, so only the folder setup fails.
      shortBase: '/o-nowhere'
    })
    expect(root).toBe(join(LONG_DATA_DIRECTORY, 'acp-temp', 'grok'))
  })
})
