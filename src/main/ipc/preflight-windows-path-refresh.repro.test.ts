import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { registryQueryMock } = vi.hoisted(() => ({ registryQueryMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFileSync: registryQueryMock
}))

import {
  __resetPersistedWindowsPathCacheForTests,
  mergePersistedWindowsPath
} from '../pty/windows-environment-path'
import { execLocalPreflightCommand } from './preflight-command-exec'

describe.runIf(process.platform === 'win32')('Windows preflight Path refresh reproduction', () => {
  const originalPath = process.env.Path ?? process.env.PATH ?? ''
  const fixtureDirs: string[] = []

  afterEach(() => {
    process.env.Path = originalPath
    registryQueryMock.mockReset()
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
    registryQueryMock.mockImplementation((_file, args: string[]) => {
      const value = String(args[1]).startsWith('HKCU') ? persistedUserPath : ''
      return `    Path    REG_SZ    ${value}\r\n`
    })
    __resetPersistedWindowsPathCacheForTests()

    await expect(execLocalPreflightCommand(command, ['/?'])).rejects.toMatchObject({
      code: 'ENOENT'
    })

    persistedUserPath = directory
    const refreshOptions = { forceRefresh: true }
    mergePersistedWindowsPath(process.env, refreshOptions)

    await expect(execLocalPreflightCommand(command, ['/?'])).resolves.toMatchObject({
      stdout: expect.any(String)
    })
    expect(registryQueryMock).toHaveBeenCalledTimes(4)
  })
})
