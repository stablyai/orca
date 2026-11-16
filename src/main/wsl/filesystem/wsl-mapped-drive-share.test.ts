import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearWslMappedDriveShareCacheForTests,
  resolveWslMappedDrivePath,
  type WslMappedDriveShareDeps
} from './wsl-mapped-drive-share'

function deps(
  realpathRoot: WslMappedDriveShareDeps['realpathRoot'],
  overrides: Partial<WslMappedDriveShareDeps> = {}
): WslMappedDriveShareDeps {
  return { platform: 'win32', realpathRoot, now: () => 0, timeoutMs: 50, ...overrides }
}

afterEach(() => {
  clearWslMappedDriveShareCacheForTests()
  vi.useRealTimers()
})

describe('resolveWslMappedDrivePath', () => {
  it('spells a path on a drive mapped to a distro share as its UNC path', async () => {
    const realpathRoot = vi.fn(async () => '\\\\wsl.localhost\\Ubuntu\\')
    await expect(resolveWslMappedDrivePath('W:\\home\\u\\repo', deps(realpathRoot))).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo'
    )
    await expect(resolveWslMappedDrivePath('w:/home/u/', deps(realpathRoot))).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u'
    )
    await expect(resolveWslMappedDrivePath('W:\\', deps(realpathRoot))).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu'
    )
    expect(realpathRoot).toHaveBeenCalledTimes(1)
    expect(realpathRoot).toHaveBeenCalledWith('W:\\')
  })

  it('keeps a drive mapped below the distro root', async () => {
    const realpathRoot = async (): Promise<string> => '\\\\wsl$\\Debian\\home\\u'
    await expect(resolveWslMappedDrivePath('X:\\repo', deps(realpathRoot))).resolves.toBe(
      '\\\\wsl$\\Debian\\home\\u\\repo'
    )
  })

  it('leaves local drives, other shares and failed lookups alone', async () => {
    await expect(
      resolveWslMappedDrivePath(
        'C:\\src',
        deps(async () => 'C:\\')
      )
    ).resolves.toBe(null)
    await expect(
      resolveWslMappedDrivePath(
        'S:\\src',
        deps(async () => '\\\\server\\share\\')
      )
    ).resolves.toBe(null)
    await expect(
      resolveWslMappedDrivePath(
        'Q:\\src',
        deps(async () => {
          throw new Error('ENOENT')
        })
      )
    ).resolves.toBe(null)
  })

  it('never asks for UNC, POSIX or non-string paths, or off Windows', async () => {
    const realpathRoot = vi.fn(async () => '\\\\wsl.localhost\\Ubuntu\\')
    await expect(
      resolveWslMappedDrivePath('\\\\wsl.localhost\\Ubuntu\\home', deps(realpathRoot))
    ).resolves.toBe(null)
    await expect(resolveWslMappedDrivePath('/home/u', deps(realpathRoot))).resolves.toBe(null)
    await expect(resolveWslMappedDrivePath(42, deps(realpathRoot))).resolves.toBe(null)
    await expect(
      resolveWslMappedDrivePath('W:\\home', deps(realpathRoot, { platform: 'linux' }))
    ).resolves.toBe(null)
    expect(realpathRoot).not.toHaveBeenCalled()
  })

  it('caches each drive, and asks again once the cache expires', async () => {
    let now = 0
    const realpathRoot = vi.fn(async () => '\\\\wsl.localhost\\Ubuntu\\')
    const options = deps(realpathRoot, { now: () => now })
    await Promise.all([
      resolveWslMappedDrivePath('W:\\a', options),
      resolveWslMappedDrivePath('w:\\b', options)
    ])
    expect(realpathRoot).toHaveBeenCalledTimes(1)
    now = 60_001
    await resolveWslMappedDrivePath('W:\\a', options)
    expect(realpathRoot).toHaveBeenCalledTimes(2)
  })

  it('answers null when a share hangs, without caching the timeout', async () => {
    vi.useFakeTimers()
    const realpathRoot = vi.fn(() => new Promise<string>(() => {}))
    const pending = resolveWslMappedDrivePath('W:\\repo', deps(realpathRoot))
    await vi.advanceTimersByTimeAsync(50)
    await expect(pending).resolves.toBe(null)
    const retry = resolveWslMappedDrivePath('W:\\repo', deps(realpathRoot))
    expect(realpathRoot).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(50)
    await expect(retry).resolves.toBe(null)
  })
})
