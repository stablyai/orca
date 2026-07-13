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
    expect(args).toEqual([
      '-d',
      'Ubuntu',
      '--',
      'sh',
      '-c',
      `if [ ! -d "$1" ]; then printf '%s\\n' '__ORCA_WSL_PATH_MISSING__'; exit 0; fi; readlink -f -- "$1"`,
      'sh',
      '/home/alias'
    ])
  })

  it('returns the cached path while revalidating it asynchronously', () => {
    setPlatform('win32')
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBeNull()

    const callback = execFileMock.mock.calls[0][3] as (error: Error | null, stdout: string) => void
    callback(null, '/home/alice\n')

    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBe('/home/alice')
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('resolves a custom automount root and notifies the first launch', () => {
    setPlatform('win32')
    const settled = vi.fn()
    const windowsPath = 'D:\\orca\\codex-runtime-home\\home'

    expect(
      _internals.canonicalizeWslLinuxPath(
        'Ubuntu',
        '/mnt/d/orca/codex-runtime-home/home',
        windowsPath,
        settled
      )
    ).toBeNull()

    const [file, args, options, callback] = execFileMock.mock.calls[0]
    expect(file).toBe('wsl.exe')
    expect(args).toEqual([
      '-d',
      'Ubuntu',
      '--',
      'sh',
      '-c',
      `resolved=$(wslpath -a -u "$1") || exit; if [ ! -d "$resolved" ]; then printf '%s\\n' '__ORCA_WSL_PATH_MISSING__'; exit 0; fi; readlink -f -- "$resolved"`,
      'sh',
      windowsPath
    ])
    expect(options).toMatchObject({ timeout: 5000, windowsHide: true })

    callback(null, '/windows/d/orca/codex-runtime-home/home\n')
    expect(settled).toHaveBeenCalledWith({
      status: 'resolved',
      canonicalPath: '/windows/d/orca/codex-runtime-home/home'
    })
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

  it('keeps the last known-good cache when revalidation later fails', () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    const firstCallback = execFileMock.mock.calls[0][3] as (
      error: Error | null,
      stdout: string
    ) => void
    firstCallback(null, '/home/alice\n')

    const settled = vi.fn()
    expect(
      _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias', '/home/alias', settled)
    ).toBe('/home/alice')
    const secondCallback = execFileMock.mock.calls[1][3] as (
      error: Error | null,
      stdout: string
    ) => void
    secondCallback(new Error('path disappeared'), '')

    // Why: a cold or wedged distro times out without proving the path changed.
    // Dropping the cache would force the next launch onto /mnt/... and rewrite
    // trust under a path Codex will not use when automount is customized.
    expect(settled).toHaveBeenCalledWith({ status: 'unavailable' })
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBe('/home/alice')
  })

  it('drops the cached identity when WSL confirms the path is missing', () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    const firstCallback = execFileMock.mock.calls[0][3] as (
      error: Error | null,
      stdout: string
    ) => void
    firstCallback(null, '/home/alice\n')

    const settled = vi.fn()
    expect(
      _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias', '/home/alias', settled)
    ).toBe('/home/alice')
    const secondCallback = execFileMock.mock.calls[1][3] as (
      error: Error | null,
      stdout: string
    ) => void
    secondCallback(null, '__ORCA_WSL_PATH_MISSING__\n')

    expect(settled).toHaveBeenCalledWith({ status: 'missing' })
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBeNull()
  })

  it('replaces a cached path when its canonical identity changes', () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    const firstCallback = execFileMock.mock.calls[0][3] as (
      error: Error | null,
      stdout: string
    ) => void
    firstCallback(null, '/home/alice-old\n')

    const settled = vi.fn()
    expect(
      _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias', '/home/alias', settled)
    ).toBe('/home/alice-old')
    const secondCallback = execFileMock.mock.calls[1][3] as (
      error: Error | null,
      stdout: string
    ) => void
    secondCallback(null, '/home/alice-new\n')

    expect(settled).toHaveBeenCalledWith({
      status: 'resolved',
      canonicalPath: '/home/alice-new'
    })
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBe('/home/alice-new')
  })

  it('ignores non-absolute readlink output', () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    const callback = execFileMock.mock.calls[0][3] as (error: Error | null, stdout: string) => void
    callback(null, 'readlink: missing operand\n')

    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBeNull()
  })
})
