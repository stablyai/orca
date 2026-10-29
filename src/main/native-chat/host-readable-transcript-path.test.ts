import { beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(),
  listRunningWslHomeDirsAsync: vi.fn(),
  resolveWslGuestRealDirAsync: vi.fn()
}))

// These cases cover root and path policy; the E9 gate has its own suite.
vi.mock('./wsl-transcript-running-admission', () => ({ admitWslTranscriptPath: async () => {} }))
vi.mock('../wsl/wsl-home-unless-stopped', async () => {
  const wsl = await import('../wsl')
  return {
    wslHomeUnlessStopped: (distro: string) => wsl.getWslHomeAsync(distro),
    listRunningWslHomeDirsUnlessStopped: () => wsl.listRunningWslHomeDirsAsync()
  }
})
vi.mock('../wsl', () => ({
  listRunningWslHomeDirsAsync: wslMocks.listRunningWslHomeDirsAsync,
  resolveWslGuestRealDirAsync: wslMocks.resolveWslGuestRealDirAsync
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: wslMocks.filterPathsToRunningWslDistrosAsync
}))

import {
  configureHostReadableTranscriptPathSources,
  isGuestAbsoluteLinuxPath,
  needsWslHostTranslation,
  resetHostReadableTranscriptPathCacheForTests,
  toHostReadableTranscriptPath,
  wslAgentSessionsDirs
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
  wslMocks.resolveWslGuestRealDirAsync.mockReset().mockResolvedValue(null)
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
    // Win32 probes /home against the current drive, risking a local look-alike transcript.
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

  it('probes only the attested distro when multiple guests contain the same path', async () => {
    const seen: string[] = []
    const guestPath = '/home/ada/.codex/sessions/rollout-same.jsonl'

    await expect(
      toHostReadableTranscriptPath(guestPath, {
        platform: 'win32',
        wslDistro: 'Ubuntu',
        pathExists: async (candidate) => {
          seen.push(candidate)
          return candidate.includes('Ubuntu') || candidate.includes('Debian')
        },
        listWslHomeDirs: async () => [DEBIAN_HOME, UBUNTU_HOME]
      })
    ).resolves.toBe('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout-same.jsonl')
    expect(seen).toEqual([
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout-same.jsonl'
    ])
  })

  it('keeps running-distro filtering for an attested guest path', async () => {
    const pathExists = vi.fn().mockResolvedValue(true)
    wslMocks.filterPathsToRunningWslDistrosAsync.mockResolvedValue([])

    await expect(
      toHostReadableTranscriptPath('/home/ada/.codex/sessions/rollout-stopped.jsonl', {
        platform: 'win32',
        wslDistro: 'Ubuntu',
        pathExists,
        listWslHomeDirs: async () => [UBUNTU_HOME]
      })
    ).resolves.toBeNull()
    expect(pathExists).not.toHaveBeenCalled()
    expect(wslMocks.filterPathsToRunningWslDistrosAsync).toHaveBeenCalledWith([
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout-stopped.jsonl'
    ])
  })

  it('rejects an existing UNC path from a distro other than the attested guest', async () => {
    const pathExists = vi.fn(async () => true)

    await expect(
      toHostReadableTranscriptPath('\\\\wsl.localhost\\Debian\\home\\ada\\same.jsonl', {
        platform: 'win32',
        wslDistro: 'Ubuntu',
        pathExists
      })
    ).resolves.toBeNull()
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('does not probe an attested UNC transcript after that distro stops', async () => {
    const pathExists = vi.fn(async () => true)
    wslMocks.filterPathsToRunningWslDistrosAsync.mockResolvedValue([])

    await expect(
      toHostReadableTranscriptPath(ROLLOUT_UNC, {
        platform: 'win32',
        wslDistro: 'Ubuntu',
        pathExists
      })
    ).resolves.toBeNull()
    expect(pathExists).not.toHaveBeenCalled()
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
    // Failed WSL home discovery is uncached; polling must not spawn wsl.exe every 500ms.
    const listWslHomeDirs = vi.fn(async () => [UBUNTU_HOME])
    for (let tick = 0; tick < 5; tick += 1) {
      await toHostReadableTranscriptPath(ROLLOUT_LINUX, {
        platform: 'win32',
        pathExists: async () => false,
        listWslHomeDirs
      })
    }
    await wslAgentSessionsDirs('codex', { platform: 'win32', listWslHomeDirs })
    expect(listWslHomeDirs).toHaveBeenCalledTimes(1)
  })

  it('re-probes after the TTL so a distro that was booting is not excluded forever', async () => {
    // Retry cold-boot discovery failures instead of excluding that distro for the session.
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

describe('toHostReadableTranscriptPath through guest symlinks', () => {
  // Orca's Claude profile links `<profile>/home/projects` to `~/.claude/projects`; Windows cannot follow it.
  const PROFILE_DIR = '/home/ada/.local/share/orca/claude-profiles/acct/home/projects/-home-ada-app'
  const REAL_DIR = '/home/ada/.claude/projects/-home-ada-app'
  const LINKED_PATH = `${PROFILE_DIR}/sess.jsonl`
  const REAL_UNC =
    '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\-home-ada-app\\sess.jsonl'
  const resolveGuestRealDir = async (_distro: string, dir: string): Promise<string | null> =>
    dir === PROFILE_DIR ? REAL_DIR : dir

  it('reads an attested transcript through a guest directory symlink', async () => {
    await expect(
      toHostReadableTranscriptPath(LINKED_PATH, {
        platform: 'win32',
        wslDistro: 'Ubuntu',
        pathExists: async (candidate) => candidate === REAL_UNC,
        resolveGuestRealDir
      })
    ).resolves.toBe(REAL_UNC)
  })

  it('reads an unattested transcript through a guest directory symlink', async () => {
    await expect(
      toHostReadableTranscriptPath(LINKED_PATH, {
        platform: 'win32',
        pathExists: async (candidate) => candidate === REAL_UNC,
        listWslHomeDirs: async () => [UBUNTU_HOME],
        resolveGuestRealDir
      })
    ).resolves.toBe(REAL_UNC)
  })

  it('does not ask the guest when the literal path is readable', async () => {
    const resolver = vi.fn(resolveGuestRealDir)
    await toHostReadableTranscriptPath(LINKED_PATH, {
      platform: 'win32',
      wslDistro: 'Ubuntu',
      pathExists: async () => true,
      resolveGuestRealDir: resolver
    })
    expect(resolver).not.toHaveBeenCalled()
  })

  it('resolves each directory once across resolve-poll ticks', async () => {
    // A transcript that does not exist yet must not spawn wsl.exe on every poll.
    const resolver = vi.fn(resolveGuestRealDir)
    for (let tick = 0; tick < 5; tick += 1) {
      await toHostReadableTranscriptPath(ROLLOUT_LINUX, {
        platform: 'win32',
        wslDistro: 'Ubuntu',
        pathExists: async () => false,
        resolveGuestRealDir: resolver
      })
    }
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('returns null when the guest cannot resolve the directory', async () => {
    const pathExists = vi.fn(async () => false)
    await expect(
      toHostReadableTranscriptPath(LINKED_PATH, {
        platform: 'win32',
        wslDistro: 'Ubuntu',
        pathExists,
        resolveGuestRealDir: async () => null
      })
    ).resolves.toBeNull()
    expect(pathExists).toHaveBeenCalledTimes(1)
  })

  it('shares one guest resolution between concurrent lookups of the same directory', async () => {
    const resolver = vi.fn(resolveGuestRealDir)
    const lookups = Array.from({ length: 3 }, () =>
      toHostReadableTranscriptPath(LINKED_PATH, {
        platform: 'win32',
        wslDistro: 'Ubuntu',
        pathExists: async (candidate) => candidate === REAL_UNC,
        resolveGuestRealDir: resolver
      })
    )
    await expect(Promise.all(lookups)).resolves.toEqual([REAL_UNC, REAL_UNC, REAL_UNC])
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('follows a retargeted symlink within 30 seconds', async () => {
    vi.useFakeTimers()
    try {
      const MOVED_UNC = REAL_UNC.replace('.claude', '.claude-moved')
      let target = REAL_DIR
      const call = (): Promise<string | null> =>
        toHostReadableTranscriptPath(LINKED_PATH, {
          platform: 'win32',
          wslDistro: 'Ubuntu',
          pathExists: async (candidate) => candidate === REAL_UNC || candidate === MOVED_UNC,
          resolveGuestRealDir: async () => target
        })

      await expect(call()).resolves.toBe(REAL_UNC)
      target = REAL_DIR.replace('.claude', '.claude-moved')
      vi.setSystemTime(Date.now() + 31_000)
      await expect(call()).resolves.toBe(MOVED_UNC)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a directory the guest could not resolve only after a short delay', async () => {
    // The project directory may not exist until Claude writes the first turn.
    vi.useFakeTimers()
    try {
      const resolver = vi
        .fn<(distro: string, dir: string) => Promise<string | null>>()
        .mockResolvedValueOnce(null)
        .mockImplementation(resolveGuestRealDir)
      const call = (): Promise<string | null> =>
        toHostReadableTranscriptPath(LINKED_PATH, {
          platform: 'win32',
          wslDistro: 'Ubuntu',
          pathExists: async (candidate) => candidate === REAL_UNC,
          resolveGuestRealDir: resolver
        })

      await expect(call()).resolves.toBeNull()
      await expect(call()).resolves.toBeNull()
      expect(resolver).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 31_000)
      await expect(call()).resolves.toBe(REAL_UNC)
      expect(resolver).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('wslAgentSessionsDirs', () => {
  it('returns nothing off Windows', async () => {
    await expect(
      wslAgentSessionsDirs('codex', {
        platform: 'darwin',
        listWslHomeDirs: async () => [UBUNTU_HOME]
      })
    ).resolves.toEqual([])
  })

  it('lists the managed and system Codex roots per distro home', async () => {
    await expect(
      wslAgentSessionsDirs('codex', {
        platform: 'win32',
        listWslHomeDirs: async () => [UBUNTU_HOME]
      })
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
      wslAgentSessionsDirs('codex', {
        platform: 'win32',
        listWslHomeDirs: async () => [UBUNTU_HOME]
      })
    ).resolves.toContain(`${accountHome}\\sessions`)
  })

  it('excludes managed-account roots in stopped distros', async () => {
    configureHostReadableTranscriptPathSources({
      getAdditionalCodexHomePaths: () => [`${UBUNTU_HOME}\\.codex-account`]
    })
    wslMocks.filterPathsToRunningWslDistrosAsync.mockResolvedValue([])

    await expect(
      wslAgentSessionsDirs('codex', { platform: 'win32', listWslHomeDirs: async () => [] })
    ).resolves.toEqual([])
  })
})
