import type * as NodeFs from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { filePublicationFailures, launcherDescriptors } = vi.hoisted(() => ({
  filePublicationFailures: {
    copy: 0,
    link: 0,
    replaceBeforeRename: '',
    closeAfterRename: false,
    close: 0
  },
  launcherDescriptors: { opened: 0, closed: 0 }
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
      actual.renameSync(...args)
      if (filePublicationFailures.closeAfterRename) {
        filePublicationFailures.closeAfterRename = false
        filePublicationFailures.close = 1
      }
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args)
      launcherDescriptors.opened += 1
      return fd
    },
    closeSync: (fd: number) => {
      launcherDescriptors.closed += 1
      actual.closeSync(fd)
      if (filePublicationFailures.close > 0) {
        filePublicationFailures.close -= 1
        throw Object.assign(new Error('close failed'), { code: 'EIO' })
      }
    }
  }
})
import { publishAppImageLauncherEndpoint } from './appimage-stable-launcher'

const created: string[] = []

afterEach(async () => {
  filePublicationFailures.copy = 0
  filePublicationFailures.link = 0
  filePublicationFailures.replaceBeforeRename = ''
  filePublicationFailures.closeAfterRename = false
  filePublicationFailures.close = 0
  launcherDescriptors.opened = 0
  launcherDescriptors.closed = 0
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
})
