import { beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(),
  listRunningWslHomeDirsAsync: vi.fn()
}))

vi.mock('../wsl', () => ({ listRunningWslHomeDirsAsync: wslMocks.listRunningWslHomeDirsAsync }))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: wslMocks.filterPathsToRunningWslDistrosAsync
}))

import {
  configureHostReadableTranscriptPathSources,
  isGuestAbsoluteLinuxPath,
  needsWslHostTranslation,
  resetHostReadableTranscriptPathCacheForTests,
  toHostReadableTranscriptPath,
  wslCodexSessionsDirs
} from './host-readable-transcript-path'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'

const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const DEBIAN_HOME = '\\\\wsl.localhost\\Debian\\home\\other'
const ROLLOUT_LINUX =
  '/home/ada/.local/share/orca/codex-runtime-home/home/sessions/2026/07/24/rollout-sess.jsonl'
const ROLLOUT_UNC =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\24\\rollout-sess.jsonl'

beforeEach(() => {
  resetHostReadableTranscriptPathCacheForTests()
  wslMocks.filterPathsToRunningWslDistrosAsync
    .mockReset()
    .mockImplementation(async (paths: readonly string[]) => [...paths])
  wslMocks.listRunningWslHomeDirsAsync.mockReset().mockResolvedValue([])
})

describe('isGuestAbsoluteLinuxPath', () => {
  it('accepts absolute POSIX guest paths', () => {
    expect(isGuestAbsoluteLinuxPath('/home/ada/.codex/sessions/rollout.jsonl')).toBe(true)
  })

  it('rejects UNC, relative, and drive-letter forms', () => {
    expect(isGuestAbsoluteLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\ada\\x.jsonl')).toBe(false)
    expect(isGuestAbsoluteLinuxPath('//wsl.localhost/Ubuntu/home/ada/x.jsonl')).toBe(false)
    expect(isGuestAbsoluteLinuxPath('relative/path.jsonl')).toBe(false)
    expect(isGuestAbsoluteLinuxPath('C:\\Users\\ada\\x.jsonl')).toBe(false)
    expect(isGuestAbsoluteLinuxPath('/C:/Users/ada/x.jsonl')).toBe(false)
  })
})

describe('needsWslHostTranslation', () => {
  it('is win32-only', () => {
    expect(needsWslHostTranslation(ROLLOUT_LINUX, 'win32')).toBe(true)
    expect(needsWslHostTranslation(ROLLOUT_LINUX, 'darwin')).toBe(false)
    expect(needsWslHostTranslation(ROLLOUT_UNC, 'win32')).toBe(false)
  })
})

describe('toHostReadableTranscriptPath', () => {
  it('translates a WSL guest path to its UNC twin on Windows (#10326)', async () => {
    await expect(
      toHostReadableTranscriptPath(ROLLOUT_LINUX, {
        platform: 'win32',
        pathExists: async (candidate) => candidate === ROLLOUT_UNC,
        listWslHomeDirs: async () => [UBUNTU_HOME]
      })
    ).resolves.toBe(ROLLOUT_UNC)
  })

  it('never probes the bare guest path on Windows', async () => {
    // Why: Win32 resolves `/home/...` against the current drive (`C:\home\...`),
    // so probing first could bind chat to a local look-alike file.
    const seen: string[] = []
    await expect(
      toHostReadableTranscriptPath('/home/ada/x.jsonl', {
        platform: 'win32',
        pathExists: async (candidate) => {
          seen.push(candidate)
          return true
        },
        listWslHomeDirs: async () => [UBUNTU_HOME]
      })
    ).resolves.toBe('\\\\wsl.localhost\\Ubuntu\\home\\ada\\x.jsonl')
    expect(seen).not.toContain('/home/ada/x.jsonl')
  })

  it('leaves drive-letter paths untranslated', async () => {
    const path = 'C:/home/ada/x.jsonl'
    await expect(
      toHostReadableTranscriptPath(path, {
        platform: 'win32',
        pathExists: async (candidate) => candidate === path,
        listWslHomeDirs: async () => {
          throw new Error('should not enumerate distros')
        }
      })
    ).resolves.toBe(path)
    expect(wslMocks.filterPathsToRunningWslDistrosAsync).not.toHaveBeenCalled()
  })

  it('probes an already-UNC transcript only while its distro is running', async () => {
    const pathExists = vi.fn().mockResolvedValue(true)
    await expect(
      toHostReadableTranscriptPath(ROLLOUT_UNC, { platform: 'win32', pathExists })
    ).resolves.toBe(ROLLOUT_UNC)
    expect(wslMocks.filterPathsToRunningWslDistrosAsync).toHaveBeenCalledWith([ROLLOUT_UNC])
    expect(pathExists).toHaveBeenCalledWith(ROLLOUT_UNC)
  })

  it('does not probe an already-UNC transcript after its distro stops', async () => {
    const pathExists = vi.fn().mockResolvedValue(true)
    wslMocks.filterPathsToRunningWslDistrosAsync.mockResolvedValue([])
    await expect(
      toHostReadableTranscriptPath(ROLLOUT_UNC, { platform: 'win32', pathExists })
    ).resolves.toBeNull()
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('tries the distro whose $HOME prefixes the guest path first', async () => {
    const seen: string[] = []
    await expect(
      toHostReadableTranscriptPath('/home/ada/.codex/sessions/rollout.jsonl', {
        platform: 'win32',
        pathExists: async (candidate) => {
          seen.push(candidate)
          return true
        },
        listWslHomeDirs: async () => [DEBIAN_HOME, UBUNTU_HOME]
      })
    ).resolves.toBe('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout.jsonl')
    expect(seen).toHaveLength(1)
  })

  it('returns null when no distro maps to an existing file', async () => {
    await expect(
      toHostReadableTranscriptPath(ROLLOUT_LINUX, {
        platform: 'win32',
        pathExists: async () => false,
        listWslHomeDirs: async () => [UBUNTU_HOME]
      })
    ).resolves.toBeNull()
  })

  it('prefers a later distro hit over an earlier gate refusal', async () => {
    // Guest path under Debian's $HOME so the refusing Debian probe ranks first.
    await expect(
      toHostReadableTranscriptPath('/home/other/x.jsonl', {
        platform: 'win32',
        pathExists: async (candidate) => {
          if (candidate.includes('Debian')) {
            throw new WslTranscriptFsError('timeout', 'slow share')
          }
          return candidate.includes('Ubuntu')
        },
        listWslHomeDirs: async () => [DEBIAN_HOME, UBUNTU_HOME]
      })
    ).resolves.toBe('\\\\wsl.localhost\\Ubuntu\\home\\other\\x.jsonl')
  })

  it('reports unavailability, not a miss, when a refused distro was never probed', async () => {
    const refusal = new WslTranscriptFsError('timeout', 'slow share')
    await expect(
      toHostReadableTranscriptPath('/home/other/x.jsonl', {
        platform: 'win32',
        pathExists: async (candidate) => {
          if (candidate.includes('Debian')) {
            throw refusal
          }
          return false
        },
        listWslHomeDirs: async () => [DEBIAN_HOME, UBUNTU_HOME]
      })
    ).rejects.toBe(refusal)
  })

  it('does not translate guest paths off Windows', async () => {
    await expect(
      toHostReadableTranscriptPath('/home/ada/rollout.jsonl', {
        platform: 'darwin',
        pathExists: async (candidate) => candidate === '/home/ada/rollout.jsonl',
        listWslHomeDirs: async () => {
          throw new Error('should not enumerate distros')
        }
      })
    ).resolves.toBe('/home/ada/rollout.jsonl')
  })

  it('enumerates WSL homes once across repeated resolve-poll ticks', async () => {
    // Why: getWslHomeAsync does not cache failures; re-spawning wsl.exe on every
    // 500ms poll tick would hammer the main process.
    const listWslHomeDirs = vi.fn(async () => [UBUNTU_HOME])
    for (let tick = 0; tick < 5; tick += 1) {
      await toHostReadableTranscriptPath(ROLLOUT_LINUX, {
        platform: 'win32',
        pathExists: async () => false,
        listWslHomeDirs
      })
    }
    await wslCodexSessionsDirs({ platform: 'win32', listWslHomeDirs })
    expect(listWslHomeDirs).toHaveBeenCalledTimes(1)
  })

  it('re-probes after the TTL so a distro that was booting is not excluded forever', async () => {
    // Why: getWslHomeAsync returns null for a distro whose 5s $HOME probe timed
    // out on a cold boot. Latching that partial list for the process lifetime
    // would leave that distro's transcripts permanently unresolvable (#10326).
    vi.useFakeTimers()
    try {
      const listWslHomeDirs = vi
        .fn<() => Promise<string[]>>()
        .mockResolvedValueOnce([UBUNTU_HOME])
        .mockResolvedValue([UBUNTU_HOME, DEBIAN_HOME])

      const debianRollout = '\\\\wsl.localhost\\Debian\\home\\other\\x.jsonl'
      const call = (): Promise<string | null> =>
        toHostReadableTranscriptPath('/home/other/x.jsonl', {
          platform: 'win32',
          pathExists: async (candidate) => candidate === debianRollout,
          listWslHomeDirs
        })

      await expect(call()).resolves.toBeNull()
      await expect(call()).resolves.toBeNull()
      expect(listWslHomeDirs).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 6 * 60_000)
      await expect(call()).resolves.toBe(debianRollout)
      expect(listWslHomeDirs).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a cached home after its distro stops before probing UNC', async () => {
    wslMocks.listRunningWslHomeDirsAsync
      .mockResolvedValueOnce([UBUNTU_HOME])
      .mockResolvedValueOnce([])
    const pathExists = vi.fn(async () => false)

    await toHostReadableTranscriptPath(ROLLOUT_LINUX, { platform: 'win32', pathExists })
    pathExists.mockClear()
    await toHostReadableTranscriptPath(ROLLOUT_LINUX, { platform: 'win32', pathExists })

    expect(wslMocks.listRunningWslHomeDirsAsync).toHaveBeenCalledTimes(2)
    expect(pathExists).not.toHaveBeenCalled()
  })
})

describe('wslCodexSessionsDirs', () => {
  it('returns nothing off Windows', async () => {
    await expect(
      wslCodexSessionsDirs({ platform: 'darwin', listWslHomeDirs: async () => [UBUNTU_HOME] })
    ).resolves.toEqual([])
  })

  it('lists the managed and system Codex roots per distro home', async () => {
    await expect(
      wslCodexSessionsDirs({ platform: 'win32', listWslHomeDirs: async () => [UBUNTU_HOME] })
    ).resolves.toEqual([
      `${UBUNTU_HOME}\\.local\\share\\orca\\codex-runtime-home\\home\\sessions`,
      `${UBUNTU_HOME}\\.codex\\sessions`
    ])
  })

  it('includes WSL managed-account session roots supplied by the runtime', async () => {
    const accountHome = `${UBUNTU_HOME}\\.local\\share\\orca\\codex-accounts\\account-1\\home`
    configureHostReadableTranscriptPathSources({
      getAdditionalCodexHomePaths: () => [accountHome, '/host/account/home']
    })

    await expect(
      wslCodexSessionsDirs({ platform: 'win32', listWslHomeDirs: async () => [UBUNTU_HOME] })
    ).resolves.toContain(`${accountHome}\\sessions`)
  })

  it('excludes managed-account roots in stopped distros', async () => {
    configureHostReadableTranscriptPathSources({
      getAdditionalCodexHomePaths: () => [`${UBUNTU_HOME}\\.codex-account`]
    })
    wslMocks.filterPathsToRunningWslDistrosAsync.mockResolvedValue([])

    await expect(
      wslCodexSessionsDirs({ platform: 'win32', listWslHomeDirs: async () => [] })
    ).resolves.toEqual([])
  })
})
