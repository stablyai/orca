import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyWslMappedDrive,
  clearWslMappedDriveShareCacheForTests,
  readWslMappedDriveShareNow,
  resolveWslMappedDrivePath,
  type WslMappedDriveShareDeps
} from './wsl-mapped-drive-share'
import { wslMappedDriveLastKnownShare } from './wsl-mapped-drive-last-known'

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

  it('answers null when a share hangs, and never starts a second lookup for it', async () => {
    vi.useFakeTimers()
    const realpathRoot = vi.fn(() => new Promise<string>(() => {}))
    const pending = resolveWslMappedDrivePath('W:\\repo', deps(realpathRoot))
    await vi.advanceTimersByTimeAsync(50)
    await expect(pending).resolves.toBe(null)
    const retry = resolveWslMappedDrivePath('W:\\repo', deps(realpathRoot))
    await vi.advanceTimersByTimeAsync(50)
    await expect(retry).resolves.toBe(null)
    expect(realpathRoot).toHaveBeenCalledTimes(1)
  })

  it('keeps a late answer from a cold distro for the next add', async () => {
    vi.useFakeTimers()
    let answer: (real: string) => void = () => {}
    const realpathRoot = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve
        })
    )
    const first = resolveWslMappedDrivePath('W:\\repo', deps(realpathRoot))
    await vi.advanceTimersByTimeAsync(50)
    await expect(first).resolves.toBe(null)
    answer('\\\\wsl.localhost\\Ubuntu\\')
    await expect(resolveWslMappedDrivePath('W:\\repo', deps(realpathRoot))).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\repo'
    )
    expect(realpathRoot).toHaveBeenCalledTimes(1)
  })

  it('asks again after a failed lookup', async () => {
    const realpathRoot = vi
      .fn<(root: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('EIO'))
      .mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\')
    await expect(resolveWslMappedDrivePath('W:\\a', deps(realpathRoot))).resolves.toBe(null)
    await expect(resolveWslMappedDrivePath('W:\\a', deps(realpathRoot))).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\a'
    )
    expect(realpathRoot).toHaveBeenCalledTimes(2)
  })

  it('normalizes dot segments, refusing any that climb above the drive root', async () => {
    const realpathRoot = async (): Promise<string> => '\\\\wsl.localhost\\Ubuntu\\home\\u'
    await expect(resolveWslMappedDrivePath('W:\\a\\.\\b\\..\\c', deps(realpathRoot))).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\a\\c'
    )
    await expect(resolveWslMappedDrivePath('W:\\a\\..', deps(realpathRoot))).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u'
    )
    await expect(resolveWslMappedDrivePath('W:\\..\\etc', deps(realpathRoot))).resolves.toBe(null)
  })
})

describe('readWslMappedDriveShareNow', () => {
  it('asks Windows again rather than trusting a cached answer from before a remap', async () => {
    const realpathRoot = vi
      .fn<WslMappedDriveShareDeps['realpathRoot']>()
      .mockResolvedValueOnce('\\\\wsl.localhost\\Ubuntu\\')
      .mockResolvedValueOnce('\\\\wsl.localhost\\Debian\\')
    await resolveWslMappedDrivePath('W:\\x', deps(realpathRoot))
    await expect(readWslMappedDriveShareNow('w', deps(realpathRoot))).resolves.toEqual({
      share: '\\\\wsl.localhost\\Debian'
    })
    expect(realpathRoot).toHaveBeenLastCalledWith('W:\\')
  })

  it('tells a slow drive apart from one that maps nowhere', async () => {
    await expect(
      readWslMappedDriveShareNow(
        'Q',
        deps(() => new Promise<string>(() => {}))
      )
    ).resolves.toBe('unverifiable')
    await expect(
      readWslMappedDriveShareNow(
        'W',
        deps(async () => {
          throw new Error('ENOENT')
        })
      )
    ).resolves.toEqual({ share: null })
    await expect(
      readWslMappedDriveShareNow(
        'C',
        deps(async () => 'C:\\')
      )
    ).resolves.toEqual({
      share: null
    })
  })
})

describe('fresh reads and last-known answers', () => {
  it('shares one lookup between concurrent reads, so a hung share pins one thread', async () => {
    const realpathRoot = vi.fn(() => new Promise<string>(() => {}))
    const reads = await Promise.all(
      [1, 2, 3].map(() => readWslMappedDriveShareNow('Z', deps(realpathRoot)))
    )
    expect(reads).toEqual(['unverifiable', 'unverifiable', 'unverifiable'])
    // A later read waits out the hung lookup instead of stacking another.
    await expect(readWslMappedDriveShareNow('Z', deps(realpathRoot))).resolves.toBe('unverifiable')
    expect(realpathRoot).toHaveBeenCalledTimes(1)
  })

  it('asks again once an older lookup settles, so each read is fresh', async () => {
    let answer!: (real: string) => void
    const realpathRoot = vi
      .fn<WslMappedDriveShareDeps['realpathRoot']>()
      .mockImplementationOnce(() => new Promise((done) => (answer = done)))
      .mockResolvedValueOnce('\\\\wsl.localhost\\Debian\\')
    const first = readWslMappedDriveShareNow('W', deps(realpathRoot, { timeoutMs: 500 }))
    const second = readWslMappedDriveShareNow('W', deps(realpathRoot, { timeoutMs: 500 }))
    answer('\\\\wsl.localhost\\Ubuntu\\')
    await expect(first).resolves.toEqual({ share: '\\\\wsl.localhost\\Ubuntu' })
    await expect(second).resolves.toEqual({ share: '\\\\wsl.localhost\\Debian' })
    expect(realpathRoot).toHaveBeenCalledTimes(2)
  })

  it('remembers each answer, and classifies an unknown letter with one cached lookup', async () => {
    expect(wslMappedDriveLastKnownShare('C')).toBeNull()
    const realpathRoot = vi.fn(async () => 'C:\\')
    await expect(classifyWslMappedDrive('C', deps(realpathRoot))).resolves.toEqual({ share: null })
    await expect(classifyWslMappedDrive('c', deps(realpathRoot))).resolves.toEqual({ share: null })
    expect(realpathRoot).toHaveBeenCalledTimes(1)
    await readWslMappedDriveShareNow(
      'W',
      deps(async () => '\\\\wsl.localhost\\Ubuntu\\')
    )
    expect(wslMappedDriveLastKnownShare('w')).toEqual({ share: '\\\\wsl.localhost\\Ubuntu' })
  })

  it('remembers a drive that fails to resolve as mapping nowhere', async () => {
    const missing = async (): Promise<string> => {
      throw new Error('ENOENT')
    }
    await classifyWslMappedDrive('E', deps(missing))
    expect(wslMappedDriveLastKnownShare('E')).toEqual({ share: null })
    await readWslMappedDriveShareNow('U', deps(missing))
    expect(wslMappedDriveLastKnownShare('U')).toEqual({ share: null })
  })

  it('classifies a letter again once its answer is a minute old, so a remap is seen', async () => {
    let now = 0
    const realpathRoot = vi
      .fn<WslMappedDriveShareDeps['realpathRoot']>()
      .mockResolvedValueOnce('Z:\\')
      .mockResolvedValueOnce('\\\\wsl.localhost\\Ubuntu\\')
    const clock = deps(realpathRoot, { now: () => now })
    await expect(classifyWslMappedDrive('Z', clock)).resolves.toEqual({ share: null })
    now = 30_000
    await expect(classifyWslMappedDrive('Z', clock)).resolves.toEqual({ share: null })
    now = 61_000
    await expect(classifyWslMappedDrive('Z', clock)).resolves.toEqual({
      share: '\\\\wsl.localhost\\Ubuntu'
    })
    expect(realpathRoot).toHaveBeenCalledTimes(2)
  })

  it('falls back to a stale WSL answer when re-classifying times out, so the fresh read decides', async () => {
    let now = 0
    await readWslMappedDriveShareNow(
      'W',
      deps(async () => '\\\\wsl.localhost\\Ubuntu\\', { now: () => now })
    )
    now = 120_000
    const hung = deps(() => new Promise<string>(() => {}), { now: () => now })
    await expect(classifyWslMappedDrive('W', hung)).resolves.toEqual({
      share: '\\\\wsl.localhost\\Ubuntu'
    })
  })

  it('treats an answer dated after now as unknown', async () => {
    await readWslMappedDriveShareNow(
      'F',
      deps(async () => 'F:\\', { now: () => Date.now() + 60_000 })
    )
    expect(wslMappedDriveLastKnownShare('F')).toBeNull()
  })
})
