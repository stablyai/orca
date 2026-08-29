import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __resetPersistedWindowsPathCacheForTests,
  mergePersistedWindowsPathAsync
} from '../pty/windows-environment-path'
import { __setWindowsPathRegistryLoaderForTests } from '../pty/windows-path-registry-reader'
import { execLocalPreflightCommand } from './preflight-command-exec'

describe.runIf(process.platform === 'win32')('Windows preflight Path refresh reproduction', () => {
  const originalPath = process.env.Path ?? process.env.PATH ?? ''
  const fixtureDirs: string[] = []

  afterEach(() => {
    process.env.Path = originalPath
    __setWindowsPathRegistryLoaderForTests()
    __resetPersistedWindowsPathCacheForTests()
    for (const directory of fixtureDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('finds a newly installed executable immediately after a forced refresh', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-path-refresh-'))
    fixtureDirs.push(directory)
    const command = 'orca-path-refresh-fixture.exe'
    copyFileSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'),
      join(directory, command)
    )

    let persistedUserPath = ''
    const getRegistryKey = vi.fn((root: number) => ({
      Path: { type: 1, value: root === 2 ? persistedUserPath : '' }
    }))
    __setWindowsPathRegistryLoaderForTests(() => ({
      HK: { LM: 1, CU: 2 },
      getRegistryKey
    }))
    __resetPersistedWindowsPathCacheForTests()

    await expect(execLocalPreflightCommand(command, ['/?'])).rejects.toMatchObject({
      code: 'ENOENT'
    })

    persistedUserPath = directory
    const refreshOptions = { forceRefresh: true }
    await mergePersistedWindowsPathAsync(process.env, refreshOptions)

    await expect(execLocalPreflightCommand(command, ['/?'])).resolves.toMatchObject({
      stdout: expect.any(String)
    })
    expect(getRegistryKey).toHaveBeenCalledTimes(4)
  })
})
