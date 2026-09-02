import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ownerIdentity from './managed-hook-owner-identity'
import { withManagedHookInstallLock } from './managed-hook-install-lock'

const tempHomes: string[] = []
const STALE_TOKEN = '00000000-0000-4000-8000-000000000000'
const STALE_CLAIM_TOKEN = '11111111-1111-4111-8111-111111111111'
const fsFailure = vi.hoisted(() => ({
  canonicalUnlinkPath: null as string | null,
  contendWithoutLock: null as (() => void) | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<{ link: typeof link; unlink: typeof unlink }>()
  return {
    ...original,
    link: async (...args: Parameters<typeof original.link>) => {
      if (fsFailure.contendWithoutLock && String(args[1]).endsWith('managed-hook-install.lock')) {
        fsFailure.contendWithoutLock()
        throw Object.assign(new Error('injected publication contention'), { code: 'EEXIST' })
      }
      await original.link(...args)
    },
    unlink: async (path: Parameters<typeof original.unlink>[0]) => {
      if (String(path) === fsFailure.canonicalUnlinkPath) {
        fsFailure.canonicalUnlinkPath = null
        throw Object.assign(new Error('injected unlink failure'), { code: 'EACCES' })
      }
      await original.unlink(path)
    }
  }
})

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-managed-hook-lock-'))
  tempHomes.push(home)
  return home
}

async function requireHostIdentity(): Promise<string> {
  const hostIdentity = await ownerIdentity.readManagedHookHostIdentity()
  if (!hostIdentity) {
    throw new Error('test host identity is unavailable')
  }
  return hostIdentity
}

async function createOwnedLock(
  home: string,
  processIdentity: string,
  hostIdentity?: string
): Promise<void> {
  const lockHostIdentity = hostIdentity ?? (await requireHostIdentity())
  const lockParent = join(home, '.orca')
  const ownerPath = join(lockParent, `managed-hook-install.owner-${STALE_TOKEN}.json`)
  await mkdir(lockParent, { recursive: true })
  await writeFile(
    ownerPath,
    JSON.stringify({
      token: STALE_TOKEN,
      pid: process.pid,
      hostIdentity: lockHostIdentity,
      processIdentity
    })
  )
  await link(ownerPath, join(lockParent, 'managed-hook-install.lock'))
}

afterEach(async () => {
  fsFailure.canonicalUnlinkPath = null
  fsFailure.contendWithoutLock = null
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('withManagedHookInstallLock', () => {
  it('enforces the deadline when publication contention observes a missing lock', async () => {
    const home = await createTempHome()
    const controller = new AbortController()
    const run = vi.fn()
    let now = 0
    fsFailure.contendWithoutLock = () => controller.abort()
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 10_000))

    await expect(withManagedHookInstallLock(home, controller.signal, run)).rejects.toThrow(
      'Timed out waiting for another managed-hook install to finish'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('serializes installers across relay runtime instances', async () => {
    const home = await createTempHome()
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => (markFirstStarted = resolve))
    const secondRun = vi.fn(async () => 'second')
    const first = withManagedHookInstallLock(home, undefined, () => {
      markFirstStarted()
      return new Promise<string>((resolve) => (releaseFirst = () => resolve('first')))
    })
    await firstStarted
    const second = withManagedHookInstallLock(home, undefined, secondRun)

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(secondRun).not.toHaveBeenCalled()
    releaseFirst()

    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
  })

  it('atomically publishes a complete owner record before entering the installer', async () => {
    const home = await createTempHome()
    const lockParent = join(home, '.orca')
    const lockPath = join(lockParent, 'managed-hook-install.lock')

    await withManagedHookInstallLock(home, undefined, async () => {
      const entries = await readdir(lockParent)
      const ownerEntry = entries.find((entry) => entry.startsWith('managed-hook-install.owner-'))
      expect(entries).toHaveLength(2)
      expect(ownerEntry).toBeDefined()
      if (!ownerEntry) {
        throw new Error('owner entry was not published')
      }
      const ownerPath = join(lockParent, ownerEntry)
      const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
        token: string
        pid: number
        hostIdentity: string
        processIdentity: string
      }
      expect(owner).toMatchObject({ pid: process.pid })
      expect(owner.token).toMatch(/^[\da-f-]{36}$/)
      expect(owner.hostIdentity.length).toBeGreaterThan(0)
      expect(owner.processIdentity.length).toBeGreaterThan(0)
      const [lockStats, ownerStats] = await Promise.all([lstat(lockPath), lstat(ownerPath)])
      expect(lockStats.ino).toBe(ownerStats.ino)
      expect(lockStats.nlink).toBe(2)
    })
  })

  it('fails fast instead of stealing an unverifiable legacy directory lock', async () => {
    const home = await createTempHome()
    await mkdir(join(home, '.orca', 'managed-hook-install.lock'), { recursive: true })
    const run = vi.fn()

    await expect(withManagedHookInstallLock(home, undefined, run)).rejects.toThrow(
      'unverifiable owner'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('recovers after the same SSH host reboots even if its PID and start time are reused', async () => {
    const home = await createTempHome()
    await createOwnedLock(home, 'stale-process-incarnation')

    await expect(
      withManagedHookInstallLock(home, undefined, async () => 'installed')
    ).resolves.toBe('installed')
  })

  it('does not compare PID identities or steal a lock owned by another SSH host', async () => {
    const home = await createTempHome()
    const lockPath = join(home, '.orca', 'managed-hook-install.lock')
    await createOwnedLock(home, 'stale-process-incarnation', 'another-host-boot')
    const originalLock = await readFile(lockPath, 'utf8')

    await expect(withManagedHookInstallLock(home, undefined, vi.fn())).rejects.toThrow(
      'belongs to another host'
    )
    expect(await readFile(lockPath, 'utf8')).toBe(originalLock)
  })

  it('does not steal a live lock when its owner process probe becomes unavailable', async () => {
    const home = await createTempHome()
    const lockPath = join(home, '.orca', 'managed-hook-install.lock')
    await createOwnedLock(home, 'another-process-incarnation')
    const originalLock = await readFile(lockPath, 'utf8')
    const selfIdentity = await ownerIdentity.readManagedHookProcessIdentity(process.pid)
    expect(selfIdentity).toBeTypeOf('string')
    vi.spyOn(ownerIdentity, 'readManagedHookProcessIdentity')
      .mockResolvedValueOnce(selfIdentity)
      .mockResolvedValueOnce(undefined)

    await expect(withManagedHookInstallLock(home, undefined, vi.fn())).rejects.toThrow(
      'Could not verify the managed-hook lock owner process'
    )
    expect(await readFile(lockPath, 'utf8')).toBe(originalLock)
  })

  it('serializes two contenders that concurrently recover the same dead owner', async () => {
    const home = await createTempHome()
    await createOwnedLock(home, 'stale-process-incarnation')

    let releaseFirst!: () => void
    let activeRuns = 0
    let maxActiveRuns = 0
    const run = vi.fn(async () => {
      activeRuns += 1
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns)
      if (run.mock.calls.length === 1) {
        await new Promise<void>((resolve) => (releaseFirst = resolve))
      }
      activeRuns -= 1
    })
    const first = withManagedHookInstallLock(home, undefined, run)
    const second = withManagedHookInstallLock(home, undefined, run)

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(maxActiveRuns).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(run).toHaveBeenCalledTimes(2)
    expect(maxActiveRuns).toBe(1)
  })

  it('recovers a canonical lock after its previous recovery claimant crashes', async () => {
    const home = await createTempHome()
    const lockParent = join(home, '.orca')
    const ownerPath = join(lockParent, `managed-hook-install.owner-${STALE_TOKEN}.json`)
    const claimedOwnerPath = join(
      lockParent,
      `managed-hook-install.claimed-${STALE_TOKEN}-${STALE_CLAIM_TOKEN}.json`
    )
    const claimRecordPath = join(
      lockParent,
      `managed-hook-install.claim-${STALE_TOKEN}-${STALE_CLAIM_TOKEN}.json`
    )
    const hostIdentity = await requireHostIdentity()
    await createOwnedLock(home, 'stale-owner-incarnation', hostIdentity)
    await writeFile(
      claimRecordPath,
      JSON.stringify({
        ownerToken: STALE_TOKEN,
        claimToken: STALE_CLAIM_TOKEN,
        pid: process.pid,
        hostIdentity,
        processIdentity: 'stale-claimant-incarnation'
      })
    )
    await rename(ownerPath, claimedOwnerPath)

    await expect(
      withManagedHookInstallLock(home, undefined, async () => 'installed')
    ).resolves.toBe('installed')
    expect(await readdir(lockParent)).toEqual([])
  })

  it('fails fast when a recovery claimant disappears before removing the canonical lock', async () => {
    const home = await createTempHome()
    const lockParent = join(home, '.orca')
    const lockPath = join(lockParent, 'managed-hook-install.lock')
    const ownerPath = join(lockParent, `managed-hook-install.owner-${STALE_TOKEN}.json`)
    await createOwnedLock(home, 'stale-process-incarnation')
    await unlink(ownerPath)

    const startedAt = Date.now()
    await expect(withManagedHookInstallLock(home, undefined, vi.fn())).rejects.toThrow(
      'unverifiable recovery claim'
    )
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(await readFile(lockPath, 'utf8')).toContain(STALE_TOKEN)
  })

  it('cleans an unlinked owner draft left by a crashed acquisition', async () => {
    const home = await createTempHome()
    const lockParent = join(home, '.orca')
    const staleOwnerEntry = `managed-hook-install.owner-${STALE_TOKEN}.json`
    const ownerPath = join(lockParent, staleOwnerEntry)
    await mkdir(lockParent, { recursive: true })
    const hostIdentity = await requireHostIdentity()
    await writeFile(
      ownerPath,
      JSON.stringify({
        token: STALE_TOKEN,
        pid: process.pid,
        hostIdentity,
        processIdentity: 'stale-process-incarnation'
      })
    )

    await withManagedHookInstallLock(home, undefined, async () => {
      expect(await readdir(lockParent)).not.toContain(staleOwnerEntry)
    })
    expect(await readdir(lockParent)).toEqual([])
  })

  it('does not delete a malformed final owner record that an older relay may still publish', async () => {
    const home = await createTempHome()
    const lockParent = join(home, '.orca')
    const staleOwnerEntry = `managed-hook-install.owner-${STALE_TOKEN}.json`
    const ownerPath = join(lockParent, staleOwnerEntry)
    await mkdir(lockParent, { recursive: true })
    await writeFile(ownerPath, '{"token":')
    const staleTime = new Date(Date.now() - 2_000)
    await utimes(ownerPath, staleTime, staleTime)

    await withManagedHookInstallLock(home, undefined, async () => {
      expect(await readdir(lockParent)).toContain(staleOwnerEntry)
    })
    expect(await readdir(lockParent)).toEqual([staleOwnerEntry])
  })

  it('does not let a late release delete a replacement owner lock', async () => {
    const home = await createTempHome()
    const lockPath = join(home, '.orca', 'managed-hook-install.lock')
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => (markFirstStarted = resolve))
    const first = withManagedHookInstallLock(home, undefined, () => {
      markFirstStarted()
      return new Promise<void>((resolve) => (releaseFirst = resolve))
    })
    await firstStarted
    await rename(lockPath, `${lockPath}.displaced`)

    let releaseSecond!: () => void
    let markSecondStarted!: () => void
    const secondStarted = new Promise<void>((resolve) => (markSecondStarted = resolve))
    const second = withManagedHookInstallLock(home, undefined, () => {
      markSecondStarted()
      return new Promise<void>((resolve) => (releaseSecond = resolve))
    })
    await secondStarted

    releaseFirst()
    await first
    const thirdRun = vi.fn()
    const controller = new AbortController()
    const third = withManagedHookInstallLock(home, controller.signal, thirdRun)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(thirdRun).not.toHaveBeenCalled()
    controller.abort()
    await expect(third).rejects.toMatchObject({ name: 'AbortError' })

    releaseSecond()
    await second
  })

  it('finishes an abandoned same-process release before the next install', async () => {
    const home = await createTempHome()
    const lockParent = join(home, '.orca')
    const lockPath = join(lockParent, 'managed-hook-install.lock')
    fsFailure.canonicalUnlinkPath = lockPath

    await expect(withManagedHookInstallLock(home, undefined, async () => 'first')).resolves.toBe(
      'first'
    )
    expect(await readdir(lockParent)).toContain('managed-hook-install.lock')

    const startedAt = Date.now()
    await expect(withManagedHookInstallLock(home, undefined, async () => 'second')).resolves.toBe(
      'second'
    )
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(await readdir(lockParent)).toEqual([])
  })

  it('cancels a request waiting behind another relay runtime', async () => {
    const home = await createTempHome()
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => (markFirstStarted = resolve))
    const first = withManagedHookInstallLock(home, undefined, () => {
      markFirstStarted()
      return new Promise<void>((resolve) => (releaseFirst = resolve))
    })
    await firstStarted
    const controller = new AbortController()
    const secondRun = vi.fn()
    const second = withManagedHookInstallLock(home, controller.signal, secondRun)
    await new Promise((resolve) => setTimeout(resolve, 40))

    controller.abort()

    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(secondRun).not.toHaveBeenCalled()
    releaseFirst()
    await first
  })
})
