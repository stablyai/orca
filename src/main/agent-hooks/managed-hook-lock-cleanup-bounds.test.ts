import type { Dir, OpenDirOptions, PathLike, Stats } from 'node:fs'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withManagedHookInstallLock } from './managed-hook-install-lock'
import {
  cleanupManagedHookLockFiles,
  MANAGED_HOOK_LOCK_CLEANUP_CONCURRENCY,
  MANAGED_HOOK_LOCK_DIRECTORY_BUFFER_SIZE,
  MANAGED_HOOK_LOCK_RECORD_MAX_BYTES
} from './managed-hook-lock-records'

const tempHomes: string[] = []
const ioProbe = vi.hoisted(() => ({
  active: 0,
  enabled: false,
  opendirBufferSizes: [] as number[],
  peak: 0
}))
const identityProbe = vi.hoisted(() => ({
  processIdentity: null as string | null | undefined
}))

type ProbedFsPromises = {
  lstat: (path: PathLike) => Promise<Stats>
  opendir: (path: PathLike, options?: OpenDirOptions) => Promise<Dir>
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<ProbedFsPromises>()
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const tracked = ioProbe.enabled && String(args[0]).includes('managed-hook-install.owner-feed')
      if (!tracked) {
        return await original.lstat(...args)
      }
      ioProbe.active += 1
      ioProbe.peak = Math.max(ioProbe.peak, ioProbe.active)
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
        return await original.lstat(...args)
      } finally {
        ioProbe.active -= 1
      }
    },
    opendir: async (...args: Parameters<typeof original.opendir>) => {
      const options = args[1] as { bufferSize?: number } | undefined
      if (options?.bufferSize !== undefined) {
        ioProbe.opendirBufferSizes.push(options.bufferSize)
      }
      return await original.opendir(...args)
    }
  }
})

vi.mock('./managed-hook-owner-identity', () => ({
  readManagedHookProcessIdentity: vi.fn(async () => identityProbe.processIdentity)
}))

function lockToken(prefix: string, index: number): string {
  return `${prefix}${index.toString(16).padStart(4, '0')}-0000-4000-8000-${index
    .toString(16)
    .padStart(12, '0')}`
}

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-managed-hook-cleanup-bounds-'))
  tempHomes.push(home)
  return home
}

async function seedUnrelatedFiles(directory: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(directory, `unrelated-${index.toString().padStart(4, '0')}.txt`), '')
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  ioProbe.active = 0
  ioProbe.enabled = false
  ioProbe.opendirBufferSizes.length = 0
  ioProbe.peak = 0
  identityProbe.processIdentity = null
  for (const home of tempHomes.splice(0)) {
    await rm(home, { recursive: true, force: true })
  }
})

describe('managed-hook lock cleanup bounds', () => {
  it('streams a large directory and cleans at most eight lock records concurrently', async () => {
    const home = await createTempHome()
    const lockParent = join(home, '.orca')
    const hostIdentity = 'test-host'
    const recordCount = 257
    const unrelatedCount = 320
    await mkdir(lockParent, { recursive: true })
    for (let index = 0; index < recordCount; index += 1) {
      const token = lockToken('feed', index)
      await writeFile(
        join(lockParent, `managed-hook-install.owner-${token}.json`),
        JSON.stringify({
          token,
          pid: process.pid,
          hostIdentity,
          processIdentity: 'stale-process'
        })
      )
    }
    await seedUnrelatedFiles(lockParent, unrelatedCount)
    ioProbe.enabled = true

    await cleanupManagedHookLockFiles(lockParent, hostIdentity)

    const remaining = await readdir(lockParent)
    expect(remaining).toHaveLength(unrelatedCount)
    expect(remaining.every((entry) => entry.startsWith('unrelated-'))).toBe(true)
    expect(ioProbe.peak).toBe(MANAGED_HOOK_LOCK_CLEANUP_CONCURRENCY)
    expect(ioProbe.opendirBufferSizes).toEqual([MANAGED_HOOK_LOCK_DIRECTORY_BUFFER_SIZE])
  })

  it('preserves an oversized lock record without allocating its contents', async () => {
    const home = await createTempHome()
    const lockParent = join(home, '.orca')
    const token = lockToken('feed', 1)
    const recordPath = join(lockParent, `managed-hook-install.owner-${token}.json`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(lockParent, { recursive: true })
    await writeFile(recordPath, '')
    await truncate(recordPath, MANAGED_HOOK_LOCK_RECORD_MAX_BYTES + 1)

    await cleanupManagedHookLockFiles(lockParent, 'test-host')

    expect((await stat(recordPath)).size).toBe(MANAGED_HOOK_LOCK_RECORD_MAX_BYTES + 1)
    expect(warn).toHaveBeenCalledWith(
      '[agent-hooks] Failed to clean managed-hook lock file',
      expect.objectContaining({ name: 'NodeFileReadTooLargeError' })
    )
  })

  it('recovers a claimed owner without collecting a large directory into an array', async () => {
    const home = await createTempHome()
    const lockParent = join(home, '.orca')
    const lockPath = join(lockParent, 'managed-hook-install.lock')
    const ownerToken = lockToken('cafe', 1)
    const claimToken = lockToken('face', 2)
    const ownerPath = join(lockParent, `managed-hook-install.owner-${ownerToken}.json`)
    const claimedOwnerPath = join(
      lockParent,
      `managed-hook-install.claimed-${ownerToken}-${claimToken}.json`
    )
    const hostIdentity = 'test-host'
    await mkdir(lockParent, { recursive: true })
    await writeFile(
      ownerPath,
      JSON.stringify({
        token: ownerToken,
        pid: process.pid,
        hostIdentity,
        processIdentity: 'stale-owner'
      })
    )
    await link(ownerPath, lockPath)
    await writeFile(
      join(lockParent, `managed-hook-install.claim-${ownerToken}-${claimToken}.json`),
      JSON.stringify({
        ownerToken,
        claimToken,
        pid: process.pid,
        hostIdentity,
        processIdentity: 'stale-claimant'
      })
    )
    await rename(ownerPath, claimedOwnerPath)
    await seedUnrelatedFiles(lockParent, 512)
    identityProbe.processIdentity = 'current-process'

    await expect(
      withManagedHookInstallLock(home, undefined, async () => 'installed', hostIdentity)
    ).resolves.toBe('installed')

    expect(await readFile(join(lockParent, 'unrelated-0000.txt'), 'utf8')).toBe('')
    expect(ioProbe.opendirBufferSizes.length).toBeGreaterThanOrEqual(2)
    expect(
      ioProbe.opendirBufferSizes.every(
        (bufferSize) => bufferSize === MANAGED_HOOK_LOCK_DIRECTORY_BUFFER_SIZE
      )
    ).toBe(true)
  })
})
