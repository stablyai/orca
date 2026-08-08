import { describe, expect, it } from 'vitest'

import {
  isGuestAbsoluteLinuxPath,
  resolveHostReadableTranscriptPath,
  wslClaudeProjectsDirs,
  wslCodexSessionsDirs
} from './host-readable-transcript-path'

describe('isGuestAbsoluteLinuxPath', () => {
  it('accepts absolute POSIX guest paths', () => {
    expect(isGuestAbsoluteLinuxPath('/home/ada/.codex/sessions/rollout.jsonl')).toBe(true)
    expect(isGuestAbsoluteLinuxPath('/tmp/x.jsonl')).toBe(true)
  })

  it('rejects UNC, relative, and drive-letter forms', () => {
    expect(isGuestAbsoluteLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\ada\\x.jsonl')).toBe(false)
    expect(isGuestAbsoluteLinuxPath('//wsl.localhost/Ubuntu/home/ada/x.jsonl')).toBe(false)
    expect(isGuestAbsoluteLinuxPath('relative/path.jsonl')).toBe(false)
    expect(isGuestAbsoluteLinuxPath('C:\\Users\\ada\\x.jsonl')).toBe(false)
    expect(isGuestAbsoluteLinuxPath('/C:/Users/ada/x.jsonl')).toBe(false)
  })
})

describe('resolveHostReadableTranscriptPath', () => {
  it('returns a pre-existing Windows host path unchanged', () => {
    const hostPath = 'C:\\Users\\ada\\session.jsonl'
    expect(
      resolveHostReadableTranscriptPath(hostPath, {
        platform: 'win32',
        pathExists: (candidate) => candidate === hostPath,
        listDistros: () => ['Ubuntu']
      })
    ).toBe(hostPath)
  })

  it('does not accept a colliding local drive path for a guest transcript', () => {
    const linux = '/exists'
    const unc = '\\\\wsl.localhost\\Ubuntu\\exists'
    const seen: string[] = []
    expect(
      resolveHostReadableTranscriptPath(linux, {
        platform: 'win32',
        pathExists: (candidate) => {
          seen.push(candidate)
          return candidate === linux || candidate === unc
        },
        listDistros: () => ['Ubuntu'],
        getDistroHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })
    ).toBe(unc)
    expect(seen).not.toContain(linux)
  })

  it('translates a Claude guest path to a readable WSL UNC path', () => {
    const linux = '/home/ada/.claude/projects/-home-ada-repo/session.jsonl'
    const unc =
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\-home-ada-repo\\session.jsonl'

    expect(
      resolveHostReadableTranscriptPath(linux, {
        platform: 'win32',
        pathExists: (candidate) => candidate === unc,
        listDistros: () => ['Ubuntu'],
        getDistroHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })
    ).toBe(unc)
  })

  it('translates a mounted drive path without requiring distro discovery', () => {
    const hostPath = 'C:\\Users\\ada\\.claude\\projects\\repo\\session.jsonl'
    expect(
      resolveHostReadableTranscriptPath('/mnt/c/Users/ada/.claude/projects/repo/session.jsonl', {
        platform: 'win32',
        pathExists: (candidate) => candidate === hostPath,
        listDistros: () => []
      })
    ).toBe(hostPath)
  })

  it('leaves an existing local transcript path unchanged', () => {
    const local = '/Users/ada/.claude/projects/repo/session.jsonl'
    expect(
      resolveHostReadableTranscriptPath(local, {
        platform: 'darwin',
        pathExists: (candidate) => candidate === local,
        listDistros: () => ['Ubuntu']
      })
    ).toBe(local)
  })

  it('prefers the distro whose home owns the guest path', () => {
    const linux = '/home/ada/.claude/projects/repo/session.jsonl'
    const ubuntuUnc = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\repo\\session.jsonl'
    const debianUnc = '\\\\wsl.localhost\\Debian\\home\\ada\\.claude\\projects\\repo\\session.jsonl'
    const seen: string[] = []
    expect(
      resolveHostReadableTranscriptPath(linux, {
        platform: 'win32',
        pathExists: (candidate) => {
          seen.push(candidate)
          return candidate === ubuntuUnc || candidate === debianUnc
        },
        listDistros: () => ['Debian', 'Ubuntu'],
        getDistroHome: (distro) =>
          distro === 'Ubuntu'
            ? '\\\\wsl.localhost\\Ubuntu\\home\\ada'
            : '\\\\wsl.localhost\\Debian\\home\\other'
      })
    ).toBe(ubuntuUnc)
    expect(seen).toEqual([ubuntuUnc])
  })

  it('does not prefer a distro whose reported home is the filesystem root', () => {
    const linux = '/home/ada/.claude/projects/repo/session.jsonl'
    const rootUnc = '\\\\wsl.localhost\\Root\\home\\ada\\.claude\\projects\\repo\\session.jsonl'
    const ubuntuUnc = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\repo\\session.jsonl'
    const seen: string[] = []
    expect(
      resolveHostReadableTranscriptPath(linux, {
        platform: 'win32',
        pathExists: (candidate) => {
          seen.push(candidate)
          return candidate === rootUnc || candidate === ubuntuUnc
        },
        listDistros: () => ['Root', 'Ubuntu'],
        getDistroHome: (distro) =>
          distro === 'Root' ? '\\\\wsl.localhost\\Root\\' : '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })
    ).toBe(ubuntuUnc)
    expect(seen).toEqual([ubuntuUnc])
  })

  it('returns null when no distro maps to an existing path', () => {
    expect(
      resolveHostReadableTranscriptPath('/home/ada/missing.jsonl', {
        platform: 'win32',
        pathExists: () => false,
        listDistros: () => ['Ubuntu'],
        getDistroHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })
    ).toBeNull()
  })
})

describe('wslCodexSessionsDirs', () => {
  it('lists managed and system Codex roots for each readable WSL home', () => {
    const home = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
    expect(
      wslCodexSessionsDirs({
        platform: 'win32',
        listDistros: () => ['Ubuntu'],
        getDistroHome: () => home
      })
    ).toEqual([
      `${home}\\.local\\share\\orca\\codex-runtime-home\\home\\sessions`,
      `${home}\\.codex\\sessions`
    ])
  })

  it('does not add WSL roots outside Windows', () => {
    expect(
      wslCodexSessionsDirs({
        platform: 'linux',
        listDistros: () => ['Ubuntu'],
        getDistroHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })
    ).toEqual([])
  })
})

describe('wslClaudeProjectsDirs', () => {
  it('lists the Claude projects root for every readable WSL home', () => {
    const ubuntuHome = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
    const debianHome = '\\\\wsl.localhost\\Debian\\home\\grace'

    expect(
      wslClaudeProjectsDirs({
        platform: 'win32',
        listDistros: () => ['Ubuntu', 'Missing', 'Debian'],
        getDistroHome: (distro) =>
          distro === 'Ubuntu' ? ubuntuHome : distro === 'Debian' ? debianHome : null
      })
    ).toEqual([`${ubuntuHome}\\.claude\\projects`, `${debianHome}\\.claude\\projects`])
  })

  it('does not add WSL roots outside Windows', () => {
    expect(
      wslClaudeProjectsDirs({
        platform: 'linux',
        listDistros: () => ['Ubuntu'],
        getDistroHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })
    ).toEqual([])
  })
})
