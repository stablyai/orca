import { existsSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { filePublicationFailures } = vi.hoisted(() => ({
  filePublicationFailures: { link: 0, replaceBeforeRename: '' }
}))
const registrationLock = vi.hoisted(() => ({
  completed: null as ((cacheRootPath: string) => void) | null,
  entered: null as ((cacheRootPath: string) => void) | null,
  pause: null as Promise<void> | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (filePublicationFailures.link > 0) {
        filePublicationFailures.link -= 1
        throw Object.assign(new Error('link unsupported'), { code: 'ENOTSUP' })
      }
      return actual.link(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (filePublicationFailures.replaceBeforeRename) {
        await actual.writeFile(args[0], filePublicationFailures.replaceBeforeRename, {
          mode: 0o755
        })
        filePublicationFailures.replaceBeforeRename = ''
      }
      return actual.rename(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

vi.mock('./appimage-registration-lock', () => ({
  withAppImageRegistrationLock: async <T>(
    cacheRootPath: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    registrationLock.entered?.(cacheRootPath)
    const pause = registrationLock.pause
    registrationLock.pause = null
    await pause
    const result = await operation()
    registrationLock.completed?.(cacheRootPath)
    return result
  }
}))

import { installLinuxBareOrcaDispatcher } from './linux-bare-orca-dispatcher'
import { resolveAppImageExtractedRoot } from './appimage-extracted-root'

const created: string[] = []

async function makeFixture(): Promise<{ homePath: string; resourcesPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-bare-dispatcher-'))
  created.push(root)
  const resourcesPath = join(root, 'resources')
  await mkdir(join(resourcesPath, 'bin'), { recursive: true })
  await writeFile(join(resourcesPath, 'bin', 'orca-ide'), '#!/usr/bin/env bash\n', 'utf8')
  return { homePath: join(root, 'home'), resourcesPath }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  filePublicationFailures.link = 0
  filePublicationFailures.replaceBeforeRename = ''
  registrationLock.completed = null
  registrationLock.entered = null
  registrationLock.pause = null
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('installLinuxBareOrcaDispatcher', () => {
  it('publishes when the home filesystem does not support hard links', async () => {
    const { homePath, resourcesPath } = await makeFixture()
    filePublicationFailures.link = 1

    const result = await installLinuxBareOrcaDispatcher({
      resourcesPath,
      homePath,
      appImagePath: null
    })

    expect(result.state).toBe('installed')
    await expect(readFile(result.dispatcherPath, 'utf8')).resolves.toContain(
      '# orca-serve-bare-orca-dispatcher'
    )
  })

  it('restores a displaced foreign dispatcher when hard links are unsupported', async () => {
    const { homePath, resourcesPath } = await makeFixture()
    await installLinuxBareOrcaDispatcher({ resourcesPath, homePath, appImagePath: null })
    const foreignContent = '#!/bin/sh\necho foreign\n'
    filePublicationFailures.replaceBeforeRename = foreignContent
    filePublicationFailures.link = 2

    const result = await installLinuxBareOrcaDispatcher({
      resourcesPath,
      homePath,
      appImagePath: null
    })

    expect(result.state).toBe('skipped-foreign')
    await expect(readFile(result.dispatcherPath, 'utf8')).resolves.toBe(foreignContent)
  })

  it('skips (does not clobber) a user-owned orca already at ~/.local/bin', async () => {
    const { homePath, resourcesPath } = await makeFixture()
    const dispatcherPath = join(homePath, '.local', 'bin', 'orca')
    const appImagePath = join(homePath, 'Orca.AppImage')
    await mkdir(join(homePath, '.local', 'bin'), { recursive: true })
    await writeFile(dispatcherPath, '#!/bin/sh\necho my own orca\n', 'utf8')
    await writeFile(appImagePath, '#!/usr/bin/env bash\n', 'utf8')
    const extract = vi.fn()

    const result = await installLinuxBareOrcaDispatcher({
      resourcesPath,
      homePath,
      appImagePath,
      appImageExtractRunner: extract
    })

    expect(result.state).toBe('skipped-foreign')
    expect(result.target).toBeNull()
    expect(extract).not.toHaveBeenCalled()
    expect(await readFile(dispatcherPath, 'utf8')).toBe('#!/bin/sh\necho my own orca\n')
  })

  it('preserves a foreign dispatcher created while AppImage extraction is in flight', async () => {
    const { homePath, resourcesPath } = await makeFixture()
    const appImagePath = join(homePath, 'Orca.AppImage')
    const cacheRootPath = join(homePath, 'cache')
    const dispatcherPath = join(homePath, '.local', 'bin', 'orca')
    await mkdir(homePath, { recursive: true })
    await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
    let reportStarted!: () => void
    let releaseExtraction!: () => void
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseExtraction = resolve
    })

    const installation = installLinuxBareOrcaDispatcher({
      resourcesPath,
      homePath,
      appImagePath,
      appImageCacheRootPath: cacheRootPath,
      appImageExtractRunner: async (_path, cwd) => {
        await writePayload(cwd)
        reportStarted()
        await released
      }
    })
    await started
    await mkdir(dirname(dispatcherPath), { recursive: true })
    await writeFile(dispatcherPath, '#!/bin/sh\necho foreign\n', { mode: 0o755 })
    releaseExtraction()

    await expect(installation).resolves.toMatchObject({
      state: 'skipped-foreign',
      target: null
    })
    await expect(readFile(dispatcherPath, 'utf8')).resolves.toBe('#!/bin/sh\necho foreign\n')
  })

  it('prunes old owner generations without touching a sibling namespace', async () => {
    const { homePath, resourcesPath } = await makeFixture()
    const appImagePath = join(homePath, 'Orca.AppImage')
    const cacheRootPath = join(homePath, 'cache', 'unused', '..')
    await mkdir(homePath, { recursive: true })
    await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
    const events: string[] = []
    const options = {
      resourcesPath,
      homePath,
      appImagePath,
      appImageCacheRootPath: cacheRootPath,
      appImageExtractRunner: async (_path: string, cwd: string) => {
        events.push('extract')
        await writePayload(cwd)
      }
    }

    await installLinuxBareOrcaDispatcher(options)
    const previous = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    const sibling = join(resolve(cacheRootPath), 'f'.repeat(24), 'e'.repeat(24))
    await mkdir(sibling, { recursive: true })
    await writeFile(appImagePath, '#!/usr/bin/env bash\n# next\n', { mode: 0o755 })
    const lockEntered = Promise.withResolvers<string>()
    const releaseLock = Promise.withResolvers<void>()
    events.length = 0
    registrationLock.pause = releaseLock.promise
    registrationLock.entered = (rootPath) => {
      events.push('lock-entered')
      lockEntered.resolve(rootPath)
    }
    registrationLock.completed = () => {
      events.push(
        existsSync(previous.rootPath) ? 'lock-left-before-prune' : 'lock-left-after-prune'
      )
    }

    const installation = installLinuxBareOrcaDispatcher(options)
    await expect(lockEntered.promise).resolves.toBe(resolve(cacheRootPath))
    expect(events).toEqual(['lock-entered'])
    expect(existsSync(previous.rootPath)).toBe(true)
    releaseLock.resolve()
    await installation
    const current = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!

    expect(events).toEqual(['lock-entered', 'extract', 'lock-left-after-prune'])
    expect(existsSync(previous.rootPath)).toBe(false)
    expect(existsSync(current.rootPath)).toBe(true)
    expect(existsSync(sibling)).toBe(true)
  })
})

async function writePayload(cwd: string): Promise<void> {
  const launcherDirectory = join(cwd, 'squashfs-root', 'resources', 'bin')
  await mkdir(launcherDirectory, { recursive: true })
  await writeFile(join(launcherDirectory, 'orca-ide'), '#!/usr/bin/env bash\n', { mode: 0o755 })
}
