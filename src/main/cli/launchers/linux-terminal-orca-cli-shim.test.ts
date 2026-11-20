import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

import { resolveAppImageLauncherEndpointPath } from '../appimage/appimage-stable-launcher'
import { ensureLinuxTerminalOrcaCliShimDir } from './linux-terminal-orca-cli-shim'

const created: string[] = []
const canFenceAppImageRuntime = process.platform === 'linux'

async function makeFixture(): Promise<{ userDataPath: string; resourcesPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-'))
  created.push(root)
  const resourcesPath = join(root, 'resources')
  mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
  writeFileSync(join(resourcesPath, 'bin', 'orca-ide'), '#!/usr/bin/env bash\n', 'utf8')
  return { userDataPath: join(root, 'user-data'), resourcesPath }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function readOpenFile(fd: number): string {
  const buffer = Buffer.alloc(64 * 1024)
  const length = readSync(fd, buffer, 0, buffer.length, 0)
  return buffer.subarray(0, length).toString('utf8')
}

describe('ensureLinuxTerminalOrcaCliShimDir', () => {
  it.skipIf(process.platform === 'win32')(
    'replaces an outdated shim without changing the file a running shell is reading',
    async () => {
      const first = await makeFixture()
      const second = await makeFixture()
      const shimDir = ensureLinuxTerminalOrcaCliShimDir({
        userDataPath: first.userDataPath,
        resourcesPath: first.resourcesPath,
        appImagePath: null
      })
      const shimPath = join(shimDir!, 'orca')
      const original = readFileSync(shimPath, 'utf8')
      const reader = openSync(shimPath, 'r')
      try {
        ensureLinuxTerminalOrcaCliShimDir({
          userDataPath: first.userDataPath,
          resourcesPath: second.resourcesPath,
          appImagePath: null
        })

        expect(readOpenFile(reader)).toBe(original)
        expect(readFileSync(shimPath, 'utf8')).toContain(second.resourcesPath)
        expect(statSync(shimPath).mode & 0o777).toBe(0o755)
        expect(readdirSync(shimDir!)).toEqual(['orca'])
      } finally {
        closeSync(reader)
      }
    }
  )

  it.skipIf(!canFenceAppImageRuntime)(
    'routes first-use AppImage terminals through a fenced current mount without a live endpoint',
    async () => {
      const { userDataPath, resourcesPath } = await makeFixture()
      const appImagePath = join(userDataPath, 'Orca.AppImage')
      await mkdir(userDataPath, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o755 })
      const cacheRootPath = join(userDataPath, 'cache')
      const liveLauncherPath = join(resourcesPath, 'bin', 'orca-ide')
      writeFileSync(liveLauncherPath, '#!/usr/bin/env bash\nprintf live', 'utf8')
      chmodSync(liveLauncherPath, 0o755)
      const shimDir = ensureLinuxTerminalOrcaCliShimDir({
        userDataPath,
        resourcesPath,
        appImagePath,
        appImageCacheRootPath: cacheRootPath
      })

      const shimPath = join(shimDir!, 'orca')
      const content = readFileSync(shimPath, 'utf8')
      expect(content).toContain(liveLauncherPath)
      expect(content).not.toContain('/proc/')
      expect(existsSync(resolveAppImageLauncherEndpointPath(cacheRootPath, 'live'))).toBe(false)
      await expect(
        runProcess({ program: shimPath, args: [], timeoutMs: 3_000 })
      ).resolves.toMatchObject({ code: 0, stdout: 'live' })
    }
  )

  it.skipIf(!canFenceAppImageRuntime)(
    'rejects a stale shim when its mount path is removed and reused',
    async () => {
      const { userDataPath, resourcesPath } = await makeFixture()
      const appImagePath = join(userDataPath, 'Orca.AppImage')
      const cacheRootPath = join(userDataPath, 'cache')
      await mkdir(userDataPath, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
      const liveLauncher = join(resourcesPath, 'bin', 'orca-ide')
      writeFileSync(liveLauncher, '#!/usr/bin/env bash\nprintf original', { mode: 0o755 })
      const shimDir = ensureLinuxTerminalOrcaCliShimDir({
        userDataPath,
        resourcesPath,
        appImagePath,
        appImageCacheRootPath: cacheRootPath
      })
      const shimPath = join(shimDir!, 'orca')
      await rm(liveLauncher)
      await writeFile(liveLauncher, '#!/usr/bin/env bash\nprintf replaced-by-another-mount', {
        mode: 0o755
      })

      await expect(
        runProcess({ program: shimPath, args: [], timeoutMs: 3_000 })
      ).resolves.toMatchObject({ code: 1, stdout: '' })
    }
  )
})
