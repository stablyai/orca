import { describe, expect, it } from 'vitest'

import {
  isGuestAbsoluteLinuxPath,
  resolveHostReadableTranscriptPath,
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
  it('returns a pre-existing host path unchanged (non-guest forms)', () => {
    expect(
      resolveHostReadableTranscriptPath('C:\\Users\\ada\\rollout.jsonl', {
        platform: 'win32',
        pathExists: (candidate) => candidate === 'C:\\Users\\ada\\rollout.jsonl',
        listDistros: () => ['Ubuntu']
      })
    ).toBe('C:\\Users\\ada\\rollout.jsonl')
  })

  it('does not treat a colliding local Windows path as a guest Linux transcript', () => {
    // Why: Node on Windows can resolve `/exists` as `C:\exists`; guest paths
    // must skip the raw probe and only accept a real WSL UNC translation.
    const linux = '/exists'
    const unc = '\\\\wsl.localhost\\Ubuntu\\exists'
    const seen: string[] = []
    expect(
      resolveHostReadableTranscriptPath(linux, {
        platform: 'win32',
        pathExists: (candidate) => {
          seen.push(candidate)
          // Local drive collision would exist, but must not win over WSL mapping.
          return candidate === 'C:\\exists' || candidate === unc || candidate === linux
        },
        listDistros: () => ['Ubuntu'],
        getDistroHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })
    ).toBe(unc)
    expect(seen).not.toContain(linux)
    expect(seen).toContain(unc)
  })

  it('translates a missing Linux path to a readable WSL UNC on Windows', () => {
    const linux =
      '/home/ada/.local/share/orca/codex-runtime-home/home/sessions/2026/07/24/rollout-sess.jsonl'
    const unc =
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\24\\rollout-sess.jsonl'
    expect(
      resolveHostReadableTranscriptPath(linux, {
        platform: 'win32',
        pathExists: (candidate) => candidate === unc,
        listDistros: () => ['Ubuntu'],
        getDistroHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })
    ).toBe(unc)
  })

  it('prefers the distro whose home prefixes the guest path', () => {
    const linux = '/home/ada/.codex/sessions/rollout.jsonl'
    const ubuntuUnc = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout.jsonl'
    const debianUnc = '\\\\wsl.localhost\\Debian\\home\\ada\\.codex\\sessions\\rollout.jsonl'
    const seen: string[] = []
    expect(
      resolveHostReadableTranscriptPath(linux, {
        platform: 'win32',
        pathExists: (candidate) => {
          seen.push(candidate)
          // Both UNC forms exist; home-prefix ranking must pick Ubuntu first.
          return candidate === ubuntuUnc || candidate === debianUnc
        },
        listDistros: () => ['Debian', 'Ubuntu'],
        getDistroHome: (distro) =>
          distro === 'Ubuntu'
            ? '\\\\wsl.localhost\\Ubuntu\\home\\ada'
            : '\\\\wsl.localhost\\Debian\\home\\other'
      })
    ).toBe(ubuntuUnc)
    // Why: guest Linux paths skip the raw probe on Windows; Ubuntu home ranks first.
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

  it('does not translate guest paths on non-Windows platforms', () => {
    expect(
      resolveHostReadableTranscriptPath('/home/ada/missing.jsonl', {
        platform: 'darwin',
        pathExists: () => false,
        listDistros: () => ['Ubuntu']
      })
    ).toBeNull()
  })
})

describe('wslCodexSessionsDirs', () => {
  it('returns empty outside Windows', () => {
    expect(
      wslCodexSessionsDirs({
        platform: 'darwin',
        listDistros: () => ['Ubuntu'],
        getDistroHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })
    ).toEqual([])
  })

  it('lists managed and system Codex session roots per distro home', () => {
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
})
