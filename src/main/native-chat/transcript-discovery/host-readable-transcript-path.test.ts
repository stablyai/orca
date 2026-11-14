import { beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(),
  listRunningWslHomeDirsAsync: vi.fn(),
  resolveWslGuestRealDirAsync: vi.fn(),
  admitWslTranscriptPath: vi.fn<(path: string) => Promise<void>>()
}))

// These cases cover root and path policy; the E9 gate has its own suite.
vi.mock('../transcript-filesystem/wsl-transcript-running-admission', () => ({
  admitWslTranscriptPath: wslMocks.admitWslTranscriptPath
}))
vi.mock('../../wsl/discovery/wsl-home-unless-stopped', async () => {
  const wsl = await import('../../wsl/discovery/distro-catalog')
  return {
    wslHomeUnlessStopped: (distro: string) => wsl.getWslHomeAsync(distro),
    listRunningWslHomeDirsUnlessStopped: () => wsl.listRunningWslHomeDirsAsync()
  }
})
vi.mock('../../wsl/discovery/distro-catalog', () => ({
  listRunningWslHomeDirsAsync: wslMocks.listRunningWslHomeDirsAsync
}))
vi.mock('../../wsl/filesystem/unc-path-access', () => ({
  resolveWslGuestRealDirAsync: wslMocks.resolveWslGuestRealDirAsync
}))
vi.mock('../../wsl/filesystem/wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: wslMocks.filterPathsToRunningWslDistrosAsync
}))
import {
  resetHostReadableTranscriptPathCacheForTests,
  toHostReadableTranscriptPath
} from './host-readable-transcript-path'
import { WslTranscriptFsError } from '../transcript-filesystem/wsl-transcript-fs-error'

const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const DEBIAN_HOME = '\\\\wsl.localhost\\Debian\\home\\other'
const ROLLOUT_UNC =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\24\\rollout-sess.jsonl'

beforeEach(() => {
  resetHostReadableTranscriptPathCacheForTests()
  wslMocks.filterPathsToRunningWslDistrosAsync
    .mockReset()
    .mockImplementation(async (paths: readonly string[]) => [...paths])
  wslMocks.listRunningWslHomeDirsAsync.mockReset().mockResolvedValue([])
  wslMocks.resolveWslGuestRealDirAsync.mockReset().mockResolvedValue(null)
  wslMocks.admitWslTranscriptPath.mockReset().mockResolvedValue(undefined)
})

describe('toHostReadableTranscriptPath', () => {
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

  it('reports an already-UNC transcript in a stopped distro as refused, never missing', async () => {
    const pathExists = vi.fn().mockResolvedValue(true)
    const refusal = new WslTranscriptFsError('unavailable', "WSL distro 'Ubuntu' is not running")
    wslMocks.admitWslTranscriptPath.mockRejectedValue(refusal)
    await expect(
      toHostReadableTranscriptPath(ROLLOUT_UNC, { platform: 'win32', pathExists })
    ).rejects.toBe(refusal)
    expect(pathExists).not.toHaveBeenCalled()
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
})

describe('toHostReadableTranscriptPath through guest symlinks', () => {
  // Orca's Claude profile links `<profile>/home/projects` to `~/.claude/projects`; Windows cannot follow it.
  const PROFILE_DIR = '/home/ada/.local/share/orca/claude-profiles/acct/home/projects/-home-ada-app'
  const REAL_DIR = '/home/ada/.claude/projects/-home-ada-app'
  const LINKED_PATH = `${PROFILE_DIR}/sess.jsonl`
  const REAL_UNC =
    '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\-home-ada-app\\sess.jsonl'

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
})
