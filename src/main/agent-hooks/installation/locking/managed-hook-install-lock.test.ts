import { type link, mkdtemp, rename, rm, type unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeTimersPromises from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './managed-hook-owner-identity'
import { withManagedHookInstallLock } from './managed-hook-install-lock'

const tempHomes: string[] = []
const fsFailure = vi.hoisted(
  (): {
    canonicalUnlinkPath: string | null
    contendWithoutLock: (() => void) | null
    onRetryWait: (() => void) | null
  } => ({ canonicalUnlinkPath: null, contendWithoutLock: null, onRetryWait: null })
)

vi.mock('node:timers/promises', async (importOriginal) => {
  const original = await importOriginal<typeof NodeTimersPromises>()
  return {
    ...original,
    setTimeout: async (...args: Parameters<typeof original.setTimeout>) => {
      fsFailure.onRetryWait?.()
      return await original.setTimeout(...args)
    }
  }
})

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

afterEach(async () => {
  fsFailure.canonicalUnlinkPath = null
  fsFailure.contendWithoutLock = null
  fsFailure.onRetryWait = null
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('withManagedHookInstallLock', () => {
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
    const retryStarted = new Promise<void>((resolve) => {
      fsFailure.onRetryWait = resolve
    })
    const second = withManagedHookInstallLock(home, undefined, secondRun)
    try {
      await retryStarted
      expect(secondRun).not.toHaveBeenCalled()
    } finally {
      releaseFirst()
      await Promise.allSettled([first, second])
    }
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
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
    const retryStarted = new Promise<void>((resolve) => {
      fsFailure.onRetryWait = resolve
    })
    const third = withManagedHookInstallLock(home, controller.signal, thirdRun)
    try {
      await retryStarted
      expect(thirdRun).not.toHaveBeenCalled()
      controller.abort()
      await expect(third).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      controller.abort()
      releaseSecond()
      await Promise.allSettled([second, third])
    }
    await second
  })
})
