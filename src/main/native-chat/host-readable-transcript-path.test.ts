import { beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  getWslHomeAsync: vi.fn(),
  listWslDistrosAsync: vi.fn()
}))

vi.mock('../wsl', () => wslMocks)

import {
  isGuestAbsoluteLinuxPath,
  isTranscriptPathCompatibleWithHost,
  needsWslHostTranslation,
  resetHostReadableTranscriptPathCacheForTests,
  toHostReadableTranscriptPath,
  wslClaudeProjectsDirs,
  wslClaudeProjectsDirsForDistro,
  wslCodexSessionsDirs,
  wslCodexSessionsDirsForDistro
} from './host-readable-transcript-path'

const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const DEBIAN_HOME = '\\\\wsl.localhost\\Debian\\home\\other'
const ROLLOUT_LINUX =
  '/home/ada/.local/share/orca/codex-runtime-home/home/sessions/2026/07/24/rollout-sess.jsonl'
const ROLLOUT_UNC =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\24\\rollout-sess.jsonl'

beforeEach(() => {
  resetHostReadableTranscriptPathCacheForTests()
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

describe('isTranscriptPathCompatibleWithHost', () => {
  it('constrains exact Windows paths to their authoritative host', () => {
    expect(
      isTranscriptPathCompatibleWithHost(ROLLOUT_UNC, { kind: 'wsl', distro: 'Ubuntu' }, 'win32')
    ).toBe(true)
    expect(
      isTranscriptPathCompatibleWithHost(ROLLOUT_UNC, { kind: 'wsl', distro: 'Debian' }, 'win32')
    ).toBe(false)
    expect(isTranscriptPathCompatibleWithHost(ROLLOUT_UNC, { kind: 'host' }, 'win32')).toBe(false)
    expect(
      isTranscriptPathCompatibleWithHost('C:\\Users\\ada\\x.jsonl', { kind: 'host' }, 'win32')
    ).toBe(true)
    expect(
      isTranscriptPathCompatibleWithHost(
        'C:\\Users\\ada\\x.jsonl',
        { kind: 'wsl', distro: 'Ubuntu' },
        'win32'
      )
    ).toBe(false)
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

  it('translates through only the authoritative WSL distro', async () => {
    const listWslHomeDirs = vi.fn(async () => [DEBIAN_HOME])
    const pathExists = vi.fn(async (candidate: string) => candidate === ROLLOUT_UNC)

    await expect(
      toHostReadableTranscriptPath(ROLLOUT_LINUX, {
        platform: 'win32',
        transcriptHost: { kind: 'wsl', distro: 'Ubuntu' },
        listWslHomeDirs,
        pathExists
      })
    ).resolves.toBe(ROLLOUT_UNC)

    expect(listWslHomeDirs).not.toHaveBeenCalled()
    expect(pathExists).toHaveBeenCalledTimes(1)
    expect(pathExists).toHaveBeenCalledWith(ROLLOUT_UNC)
  })

  it('does not reinterpret a guest path when the PTY belongs to the host', async () => {
    const listWslHomeDirs = vi.fn(async () => [UBUNTU_HOME])
    const pathExists = vi.fn(async () => true)

    await expect(
      toHostReadableTranscriptPath(ROLLOUT_LINUX, {
        platform: 'win32',
        transcriptHost: { kind: 'host' },
        listWslHomeDirs,
        pathExists
      })
    ).resolves.toBeNull()

    expect(listWslHomeDirs).not.toHaveBeenCalled()
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('rejects exact paths that contradict authoritative provenance', async () => {
    const pathExists = vi.fn(async () => true)

    await expect(
      toHostReadableTranscriptPath(ROLLOUT_UNC, {
        platform: 'win32',
        transcriptHost: { kind: 'host' },
        pathExists
      })
    ).resolves.toBeNull()
    await expect(
      toHostReadableTranscriptPath(ROLLOUT_UNC, {
        platform: 'win32',
        transcriptHost: { kind: 'wsl', distro: 'Debian' },
        pathExists
      })
    ).resolves.toBeNull()
    await expect(
      toHostReadableTranscriptPath('C:\\Users\\ada\\rollout.jsonl', {
        platform: 'win32',
        transcriptHost: { kind: 'wsl', distro: 'Ubuntu' },
        pathExists
      })
    ).resolves.toBeNull()

    expect(pathExists).not.toHaveBeenCalled()
  })

  it('classifies extended WSL UNC paths before authoritative probing', async () => {
    const extendedUnc =
      '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout.jsonl'
    const pathExists = vi.fn(async () => true)

    await expect(
      toHostReadableTranscriptPath(extendedUnc, {
        platform: 'win32',
        transcriptHost: { kind: 'host' },
        pathExists
      })
    ).resolves.toBeNull()
    await expect(
      toHostReadableTranscriptPath(extendedUnc, {
        platform: 'win32',
        transcriptHost: { kind: 'wsl', distro: 'Debian' },
        pathExists
      })
    ).resolves.toBeNull()
    await expect(
      toHostReadableTranscriptPath(extendedUnc, {
        platform: 'win32',
        transcriptHost: { kind: 'wsl', distro: 'Ubuntu' },
        pathExists
      })
    ).resolves.toBe(extendedUnc)

    expect(pathExists).toHaveBeenCalledOnce()
    expect(pathExists).toHaveBeenCalledWith(extendedUnc)
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

  it('leaves drive-letter and UNC paths untranslated', async () => {
    const existing = ['C:/home/ada/x.jsonl', ROLLOUT_UNC]
    for (const path of existing) {
      await expect(
        toHostReadableTranscriptPath(path, {
          platform: 'win32',
          pathExists: async (candidate) => candidate === path,
          listWslHomeDirs: async () => {
            throw new Error('should not enumerate distros')
          }
        })
      ).resolves.toBe(path)
    }
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
    await wslClaudeProjectsDirs({ platform: 'win32', listWslHomeDirs })
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
})

describe('wslCodexSessionsDirs', () => {
  it('returns nothing off Windows', async () => {
    await expect(
      wslCodexSessionsDirs({ platform: 'darwin', listWslHomeDirs: async () => [UBUNTU_HOME] })
    ).resolves.toEqual([])
  })

  it('loads only the requested distro for targeted resolution', async () => {
    const getWslHomeDir = vi.fn(async () => UBUNTU_HOME)

    await expect(
      wslCodexSessionsDirsForDistro('Ubuntu', { platform: 'win32', getWslHomeDir })
    ).resolves.toEqual([
      `${UBUNTU_HOME}\\.local\\share\\orca\\codex-runtime-home\\home\\sessions`,
      `${UBUNTU_HOME}\\.codex\\sessions`
    ])
    expect(getWslHomeDir).toHaveBeenCalledWith('Ubuntu')
  })

  it('coalesces concurrent targeted home probes across agents', async () => {
    let finish!: (home: string | null) => void
    const pending = new Promise<string | null>((resolve) => (finish = resolve))
    const getWslHomeDir = vi.fn(() => pending)

    const codex = wslCodexSessionsDirsForDistro('Ubuntu', {
      platform: 'win32',
      getWslHomeDir
    })
    const claude = wslClaudeProjectsDirsForDistro('ubuntu', {
      platform: 'win32',
      getWslHomeDir
    })

    expect(getWslHomeDir).toHaveBeenCalledTimes(1)
    finish(UBUNTU_HOME)
    await expect(codex).resolves.toHaveLength(2)
    await expect(claude).resolves.toEqual([`${UBUNTU_HOME}\\.claude\\projects`])
  })

  it('coalesces concurrent broad and targeted home probes', async () => {
    let finish!: (home: string | null) => void
    const pending = new Promise<string | null>((resolve) => (finish = resolve))
    wslMocks.listWslDistrosAsync.mockResolvedValue(['Ubuntu'])
    wslMocks.getWslHomeAsync.mockReturnValue(pending)

    const broad = wslCodexSessionsDirs({ platform: 'win32' })
    await Promise.resolve()
    const targeted = wslCodexSessionsDirsForDistro('Ubuntu', { platform: 'win32' })

    expect(wslMocks.getWslHomeAsync).toHaveBeenCalledTimes(1)
    finish(UBUNTU_HOME)
    await expect(broad).resolves.toHaveLength(2)
    await expect(targeted).resolves.toHaveLength(2)
  })

  it('negatively caches a failed targeted home probe for the retry window', async () => {
    vi.useFakeTimers()
    try {
      const getWslHomeDir = vi.fn(async () => null)
      const load = (): Promise<string[]> =>
        wslCodexSessionsDirsForDistro('Ubuntu', { platform: 'win32', getWslHomeDir })

      await expect(load()).resolves.toEqual([])
      await expect(load()).resolves.toEqual([])
      expect(getWslHomeDir).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 30_001)
      await expect(load()).resolves.toEqual([])
      expect(getWslHomeDir).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists the managed and system Codex roots per distro home', async () => {
    await expect(
      wslCodexSessionsDirs({ platform: 'win32', listWslHomeDirs: async () => [UBUNTU_HOME] })
    ).resolves.toEqual([
      `${UBUNTU_HOME}\\.local\\share\\orca\\codex-runtime-home\\home\\sessions`,
      `${UBUNTU_HOME}\\.codex\\sessions`
    ])
  })
})

describe('wslClaudeProjectsDirs', () => {
  it('returns nothing off Windows', async () => {
    await expect(
      wslClaudeProjectsDirs({ platform: 'linux', listWslHomeDirs: async () => [UBUNTU_HOME] })
    ).resolves.toEqual([])
  })

  it('lists the Claude projects root for each distro home', async () => {
    await expect(
      wslClaudeProjectsDirs({
        platform: 'win32',
        listWslHomeDirs: async () => [UBUNTU_HOME, DEBIAN_HOME]
      })
    ).resolves.toEqual([`${UBUNTU_HOME}\\.claude\\projects`, `${DEBIAN_HOME}\\.claude\\projects`])
  })

  it('loads only the requested distro for targeted resolution', async () => {
    const getWslHomeDir = vi.fn(async () => DEBIAN_HOME)

    await expect(
      wslClaudeProjectsDirsForDistro('Debian', { platform: 'win32', getWslHomeDir })
    ).resolves.toEqual([`${DEBIAN_HOME}\\.claude\\projects`])
    expect(getWslHomeDir).toHaveBeenCalledWith('Debian')
  })
})
