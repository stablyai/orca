import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }))

vi.mock('../../shared/node-bounded-file-reader', () => ({
  readNodeFileSyncWithinLimit: (path: string, maxBytes: number) => {
    const buffer = Buffer.from(readFileSyncMock(path) as string)
    if (buffer.byteLength > maxBytes) {
      throw new Error('File too large')
    }
    return { buffer, stats: { size: buffer.byteLength } }
  }
}))

import {
  __resetShellStartupEnvCache,
  MAX_SHELL_STARTUP_CACHE_BYTES,
  MAX_SHELL_STARTUP_CACHE_ENTRIES,
  MAX_SHELL_STARTUP_ENV_VALUE_CODE_UNITS,
  MAX_SHELL_STARTUP_FILE_BYTES,
  readShellStartupEnvVar
} from './shell-startup-env'

describe('shell startup environment memory bounds', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    readFileSyncMock.mockReset()
    __resetShellStartupEnvCache()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('accepts an exact-size startup file and skips the next byte', () => {
    const assignment = 'export TARGET=/bounded\n'
    readFileSyncMock.mockReturnValue(
      assignment + '#'.repeat(MAX_SHELL_STARTUP_FILE_BYTES - assignment.length)
    )
    expect(readShellStartupEnvVar('TARGET', '/home/alice', '/bin/zsh')).toBe('/bounded')

    __resetShellStartupEnvCache()
    readFileSyncMock.mockReturnValue(
      assignment + '#'.repeat(MAX_SHELL_STARTUP_FILE_BYTES - assignment.length + 1)
    )
    expect(readShellStartupEnvVar('TARGET', '/home/alice', '/bin/zsh')).toBeUndefined()
  })

  it('does not retain an oversized exported value', () => {
    readFileSyncMock.mockReturnValue(
      `export TARGET=${'x'.repeat(MAX_SHELL_STARTUP_ENV_VALUE_CODE_UNITS + 1)}\n`
    )

    expect(readShellStartupEnvVar('TARGET', '/home/alice', '/bin/zsh')).toBeUndefined()
  })

  it('caps cache entries with LRU recovery', () => {
    readFileSyncMock.mockReturnValue('')
    for (let index = 0; index <= MAX_SHELL_STARTUP_CACHE_ENTRIES; index += 1) {
      readShellStartupEnvVar(`TARGET_${index}`, '/home/alice', '/bin/zsh')
    }
    const readsBeforeRetry = readFileSyncMock.mock.calls.length

    readShellStartupEnvVar('TARGET_0', '/home/alice', '/bin/zsh')

    expect(readFileSyncMock.mock.calls.length).toBeGreaterThan(readsBeforeRetry)
  })

  it('caps aggregate cached key/value memory independently of entry count', () => {
    expect(MAX_SHELL_STARTUP_CACHE_BYTES).toBe(8 * 1024 * 1024)
    const value = 'x'.repeat(MAX_SHELL_STARTUP_ENV_VALUE_CODE_UNITS)
    for (let index = 0; index < 65; index += 1) {
      readFileSyncMock.mockReturnValue(`export TARGET_${index}=${value}\n`)
      expect(readShellStartupEnvVar(`TARGET_${index}`, '/home/alice', '/bin/zsh')).toBe(value)
    }
    const readsBeforeRetry = readFileSyncMock.mock.calls.length
    readFileSyncMock.mockReturnValue(`export TARGET_0=${value}\n`)

    readShellStartupEnvVar('TARGET_0', '/home/alice', '/bin/zsh')

    expect(readFileSyncMock.mock.calls.length).toBeGreaterThan(readsBeforeRetry)
  })
})
