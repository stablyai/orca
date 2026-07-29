import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { registryQueryAsyncMock, registryQuerySyncMock } = vi.hoisted(() => ({
  registryQueryAsyncMock: vi.fn(),
  registryQuerySyncMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const originalExecFile = original.execFile as (
    command: string,
    commandArgs: string[],
    commandOptions: unknown,
    commandCallback: (error: Error | null, stdout: string, stderr: string) => void
  ) => unknown
  const registryAwareExecFile = (
    file: string,
    args: string[],
    options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): unknown => {
    if (file.toLowerCase().endsWith('\\reg.exe')) {
      return registryQueryAsyncMock(file, args, options, callback)
    }
    return originalExecFile(file, args, options, callback)
  }
  const customPromisify = Symbol.for('nodejs.util.promisify.custom')
  Object.defineProperty(registryAwareExecFile, customPromisify, {
    value: (originalExecFile as unknown as Record<symbol, unknown>)[customPromisify]
  })
  return {
    ...original,
    execFile: registryAwareExecFile,
    execFileSync: registryQuerySyncMock
  }
})

import {
  __resetPersistedWindowsPathCacheForTests,
  mergePersistedWindowsPathAsync
} from '../pty/windows-environment-path'
import { execLocalPreflightCommand } from './preflight-command-exec'

describe.runIf(process.platform === 'win32')('Windows preflight Path refresh reproduction', () => {
  const originalPath = process.env.Path ?? process.env.PATH ?? ''
  const fixtureDirs: string[] = []

  afterEach(() => {
    process.env.Path = originalPath
    registryQueryAsyncMock.mockReset()
    registryQuerySyncMock.mockReset()
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
    registryQuerySyncMock.mockImplementation((_file, args: string[]) => {
      const value = String(args[1]).startsWith('HKCU') ? persistedUserPath : ''
      return `    Path    REG_SZ    ${value}\r\n`
    })
    registryQueryAsyncMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        const value = String(args[1]).startsWith('HKCU') ? persistedUserPath : ''
        callback(null, `    Path    REG_SZ    ${value}\r\n`, '')
        return {} as never
      }
    )
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
    expect(registryQuerySyncMock).toHaveBeenCalledTimes(2)
    expect(registryQueryAsyncMock).toHaveBeenCalledTimes(2)
  })
})
