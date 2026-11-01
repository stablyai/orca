import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { probeAppImageCache } from './appimage-serve-preparation'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-appimage-serve-'))
  created.push(root)
  const appImagePath = join(root, 'Orca.AppImage')
  await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
  return { root, appImagePath, cacheRootPath: join(root, 'cache') }
}

// POSIX permissions and shebang execution are what the probe measures.
describe.skipIf(process.platform === 'win32')('probeAppImageCache', () => {
  it('accepts a private, writable cache that can run programs', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    await expect(probeAppImageCache(cacheRootPath, appImagePath)).resolves.toBeNull()
  })

  it('refuses a cache other users can write to', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    await mkdir(cacheRootPath, { recursive: true })
    await chmod(cacheRootPath, 0o777)
    await expect(probeAppImageCache(cacheRootPath, appImagePath)).resolves.toContain(
      'writable by other users'
    )
  })

  it.skipIf(process.getuid?.() === 0)('refuses a cache it cannot write to', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    await mkdir(cacheRootPath, { recursive: true })
    await chmod(cacheRootPath, 0o500)
    try {
      await expect(probeAppImageCache(cacheRootPath, appImagePath)).resolves.toContain(
        'not writable'
      )
    } finally {
      await chmod(cacheRootPath, 0o700)
    }
  })
})
