import { existsSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

const { filePublicationFailures } = vi.hoisted(() => ({
  filePublicationFailures: { copy: 0, link: 0, replaceBeforeRename: '' }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      if (filePublicationFailures.copy > 0) {
        filePublicationFailures.copy -= 1
        throw Object.assign(new Error('copy unsupported'), { code: 'ENOTSUP' })
      }
      return actual.copyFileSync(...args)
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (filePublicationFailures.link > 0) {
        filePublicationFailures.link -= 1
        throw Object.assign(new Error('link unsupported'), { code: 'ENOTSUP' })
      }
      return actual.linkSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (filePublicationFailures.replaceBeforeRename) {
        actual.writeFileSync(args[0], filePublicationFailures.replaceBeforeRename, { mode: 0o755 })
        filePublicationFailures.replaceBeforeRename = ''
      }
      return actual.renameSync(...args)
    }
  }
})
import {
  publishAppImageLauncherEndpoint,
  resolveAppImageLauncherEndpointPath,
  resolveAppImageStableLauncherPath
} from './appimage-stable-launcher'

const created: string[] = []

afterEach(async () => {
  filePublicationFailures.copy = 0
  filePublicationFailures.link = 0
  filePublicationFailures.replaceBeforeRename = ''
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeFixture(): Promise<string> {
  const cacheRootPath = await mkdtemp(join(tmpdir(), 'orca-stable-appimage-launcher-'))
  created.push(cacheRootPath)
  return cacheRootPath
}

async function writeLauncher(path: string, output: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `#!/usr/bin/env bash\nprintf '${output}'`, { mode: 0o755 })
}

describe.skipIf(process.platform === 'win32')('AppImage stable launcher', () => {
  it('uses only the installed payload and ignores a legacy live endpoint', async () => {
    const cacheRootPath = await makeFixture()
    const livePath = join(cacheRootPath, 'payloads', 'live')
    const installedPath = join(cacheRootPath, 'payloads', 'installed')
    await Promise.all([writeLauncher(livePath, 'live'), writeLauncher(installedPath, 'installed')])

    const launcherPath = publishAppImageLauncherEndpoint(cacheRootPath, 'installed', installedPath)!
    await symlink(livePath, resolveAppImageLauncherEndpointPath(cacheRootPath, 'live'))
    await expect(
      runProcess({ program: launcherPath, args: [], timeoutMs: 3_000 })
    ).resolves.toMatchObject({ code: 0, stdout: 'installed' })
    expect(await readFile(launcherPath, 'utf8')).not.toContain('/live')
  })

  it('observes an endpoint published after the wrapper starts', async () => {
    const cacheRootPath = await makeFixture()
    const missingPath = join(cacheRootPath, 'payloads', 'missing')
    const readyPath = join(cacheRootPath, 'payloads', 'ready')
    const launcherPath = publishAppImageLauncherEndpoint(cacheRootPath, 'installed', missingPath)!
    const invocation = runProcess({ program: launcherPath, args: [], timeoutMs: 3_000 })
    setTimeout(() => {
      void writeLauncher(readyPath, 'ready').then(() => {
        publishAppImageLauncherEndpoint(cacheRootPath, 'installed', readyPath)
      })
    }, 100)

    await expect(invocation).resolves.toMatchObject({ code: 0, stdout: 'ready' })
  })

  it('atomically upgrades a stale marker-owned launcher', async () => {
    const cacheRootPath = await makeFixture()
    const targetPath = join(cacheRootPath, 'payloads', 'target')
    await writeLauncher(targetPath, 'target')
    const launcherPath = publishAppImageLauncherEndpoint(cacheRootPath, 'installed', targetPath)!
    const marker = (await readFile(launcherPath, 'utf8')).split('\n')[1]
    await writeFile(launcherPath, `#!/usr/bin/env bash\n${marker}\nprintf stale`, { mode: 0o755 })

    expect(publishAppImageLauncherEndpoint(cacheRootPath, 'installed', targetPath)).toBe(
      launcherPath
    )
    expect(await readFile(launcherPath, 'utf8')).toContain('launcher_dir=')
    await expect(
      runProcess({ program: launcherPath, args: [], timeoutMs: 3_000 })
    ).resolves.toMatchObject({ code: 0, stdout: 'target' })
  })

  it('publishes on a cache filesystem without hard-link support', async () => {
    const cacheRootPath = await makeFixture()
    const targetPath = join(cacheRootPath, 'payloads', 'target')
    await writeLauncher(targetPath, 'target')
    filePublicationFailures.link = 1

    const launcherPath = publishAppImageLauncherEndpoint(cacheRootPath, 'installed', targetPath)

    expect(launcherPath).toBe(resolveAppImageStableLauncherPath(cacheRootPath))
    await expect(readFile(launcherPath!, 'utf8')).resolves.toContain('launcher_dir=')
  })

  it('restores a displaced owned launcher when its replacement cannot be published', async () => {
    const cacheRootPath = await makeFixture()
    const targetPath = join(cacheRootPath, 'payloads', 'target')
    await writeLauncher(targetPath, 'target')
    const launcherPath = publishAppImageLauncherEndpoint(cacheRootPath, 'installed', targetPath)!
    const marker = (await readFile(launcherPath, 'utf8')).split('\n')[1]
    const staleContent = `#!/usr/bin/env bash\n${marker}\nprintf stale`
    await writeFile(launcherPath, staleContent, { mode: 0o755 })
    filePublicationFailures.link = 2
    filePublicationFailures.copy = 2

    expect(publishAppImageLauncherEndpoint(cacheRootPath, 'installed', targetPath)).toBeNull()
    await expect(readFile(launcherPath, 'utf8')).resolves.toBe(staleContent)
  })

  it('restores a displaced foreign launcher when hard links are unsupported', async () => {
    const cacheRootPath = await makeFixture()
    const targetPath = join(cacheRootPath, 'payloads', 'target')
    await writeLauncher(targetPath, 'target')
    const launcherPath = publishAppImageLauncherEndpoint(cacheRootPath, 'installed', targetPath)!
    const marker = (await readFile(launcherPath, 'utf8')).split('\n')[1]
    await writeFile(launcherPath, `#!/usr/bin/env bash\n${marker}\nprintf stale`, { mode: 0o755 })
    const foreignContent = '#!/usr/bin/env bash\nprintf foreign'
    filePublicationFailures.replaceBeforeRename = foreignContent
    filePublicationFailures.link = 2

    expect(publishAppImageLauncherEndpoint(cacheRootPath, 'installed', targetPath)).toBeNull()
    await expect(readFile(launcherPath, 'utf8')).resolves.toBe(foreignContent)
  })

  it('preserves a foreign launcher and declines endpoint publication', async () => {
    const cacheRootPath = await makeFixture()
    const launcherPath = resolveAppImageStableLauncherPath(cacheRootPath)
    const endpointPath = resolveAppImageLauncherEndpointPath(cacheRootPath, 'installed')
    await mkdir(dirname(launcherPath), { recursive: true })
    await writeFile(launcherPath, '#!/usr/bin/env bash\nprintf foreign', { mode: 0o755 })

    expect(
      publishAppImageLauncherEndpoint(cacheRootPath, 'installed', join(cacheRootPath, 'target'))
    ).toBeNull()
    await expect(readFile(launcherPath, 'utf8')).resolves.toContain('foreign')
    expect(existsSync(endpointPath)).toBe(false)
  })

  it('preserves an oversized foreign launcher without treating its marker as ownership', async () => {
    const cacheRootPath = await makeFixture()
    const launcherPath = resolveAppImageStableLauncherPath(cacheRootPath)
    const content = `#!/usr/bin/env bash\n# orca-appimage-stable-launcher\n${'x'.repeat(20_000)}`
    await mkdir(dirname(launcherPath), { recursive: true })
    await writeFile(launcherPath, content, { mode: 0o755 })

    expect(
      publishAppImageLauncherEndpoint(cacheRootPath, 'installed', join(cacheRootPath, 'target'))
    ).toBeNull()
    await expect(readFile(launcherPath, 'utf8')).resolves.toBe(content)
  })
})
