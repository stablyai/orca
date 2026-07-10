import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

import { _internals } from './codex-wsl-hook-install-plan'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  execFileMock.mockReset()
  _internals.resetWslCanonicalPathCache()
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('canonicalizeWslLinuxPath', () => {
  it('returns the path unchanged off Windows without spawning wsl.exe', () => {
    setPlatform('linux')
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alice')).toBe('/home/alice')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('never blocks: returns null and schedules an async resolution on first call', () => {
    setPlatform('win32')
    const result = _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')

    expect(result).toBeNull()
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [file, args] = execFileMock.mock.calls[0]
    expect(file).toBe('wsl.exe')
    expect(args).toEqual(['-d', 'Ubuntu', '--', 'readlink', '-f', '--', '/home/alias'])
  })

  it('caches the resolved canonical path and stops spawning wsl.exe', () => {
    setPlatform('win32')
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBeNull()

    const callback = execFileMock.mock.calls[0][3] as (error: Error | null, stdout: string) => void
    callback(null, '/home/alice\n')

    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBe('/home/alice')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('does not spawn a second subprocess while one is in flight', () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')

    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed resolution rather than caching the failure', () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    const callback = execFileMock.mock.calls[0][3] as (error: Error | null, stdout: string) => void
    callback(new Error('wsl unreachable'), '')

    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBeNull()
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('ignores non-absolute readlink output', () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    const callback = execFileMock.mock.calls[0][3] as (error: Error | null, stdout: string) => void
    callback(null, 'readlink: missing operand\n')

    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBeNull()
  })
})
