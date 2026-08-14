import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillDiscoveryResult } from '../../shared/skills'
import type { Repo } from '../../shared/types'

const { nativeScans, wslScans } = vi.hoisted(() => ({
  nativeScans: [] as unknown[],
  wslScans: [] as unknown[]
}))

const emptyResult = (): SkillDiscoveryResult => ({ skills: [], sources: [], scannedAt: 1 })

vi.mock('./discovery', () => ({
  clearSkillRootScanCache: vi.fn(),
  discoverSkills: vi.fn(async (args: unknown) => {
    nativeScans.push(args)
    return emptyResult()
  })
}))

vi.mock('./skill-discovery-wsl', () => ({
  discoverSkillsInWsl: vi.fn(async (args: unknown) => {
    wslScans.push(args)
    return emptyResult()
  })
}))

const { clearSkillDiscoveryCaches, discoverSkillsOnTarget } =
  await import('./skill-discovery-target')
const { clearSkillRootScanCache } = await import('./discovery')

function makeRepo(path: string): Repo {
  return {
    id: `repo-${path}`,
    path,
    displayName: 'Repo',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: null
  }
}

beforeEach(() => {
  clearSkillDiscoveryCaches()
  nativeScans.length = 0
  wslScans.length = 0
  vi.mocked(clearSkillRootScanCache).mockClear()
})

afterEach(() => {
  clearSkillDiscoveryCaches()
})

describe('discoverSkillsOnTarget', () => {
  it('collapses simultaneous identical requests from several clients into one scan', async () => {
    await Promise.all(
      Array.from({ length: 12 }, () =>
        discoverSkillsOnTarget({ kind: 'native-host', cwd: '/workspace' }, [])
      )
    )

    expect(nativeScans).toHaveLength(1)
  })

  it('does not let two workspaces share a scan', async () => {
    await Promise.all([
      discoverSkillsOnTarget({ kind: 'native-host', cwd: '/workspace-a' }, []),
      discoverSkillsOnTarget({ kind: 'native-host', cwd: '/workspace-b' }, [])
    ])

    expect(nativeScans).toEqual([
      { repos: [], cwd: '/workspace-a', refresh: false },
      { repos: [], cwd: '/workspace-b', refresh: false }
    ])
  })

  it('does not let two repo lists share a scan', async () => {
    await Promise.all([
      discoverSkillsOnTarget({ kind: 'native-host', cwd: undefined }, [makeRepo('/repo-a')]),
      discoverSkillsOnTarget({ kind: 'native-host', cwd: undefined }, [makeRepo('/repo-b')])
    ])

    expect(nativeScans).toHaveLength(2)
  })

  // Why: two clients can hold the same repo set in a different stored order. If the
  // digest is order-sensitive they get different keys and each runs a full native
  // scan — the fan-out this cache exists to bound. ttl is 0 here, so the pin is
  // that two *concurrent* callers coalesce, which they only do on an equal key.
  it('keeps repo-list identity stable regardless of stored order', async () => {
    const repos = [makeRepo('/repo-a'), makeRepo('/repo-b')]
    await discoverSkillsOnTarget({ kind: 'native-host', cwd: undefined }, repos)
    await Promise.all([
      discoverSkillsOnTarget({ kind: 'native-host', cwd: undefined }, repos.toReversed()),
      discoverSkillsOnTarget({ kind: 'native-host', cwd: undefined }, repos)
    ])

    expect(nativeScans).toHaveLength(2)
  })

  it('forwards refresh to the native scan so it re-reads disk', async () => {
    await discoverSkillsOnTarget({ kind: 'native-host', cwd: '/workspace' }, [], { refresh: true })

    expect(nativeScans).toEqual([{ repos: [], cwd: '/workspace', refresh: true }])
  })

  it('reuses a WSL result rather than booting wsl.exe again', async () => {
    const target = {
      kind: 'wsl',
      distro: 'Ubuntu',
      homeDir: '/home/dev',
      cwd: '/home/dev/repo'
    } as const

    await discoverSkillsOnTarget(target, [])
    await discoverSkillsOnTarget(target, [])

    expect(wslScans).toHaveLength(1)
  })

  it('never shares a WSL result across distros or workspaces', async () => {
    await discoverSkillsOnTarget(
      { kind: 'wsl', distro: 'Ubuntu', homeDir: '/home/dev', cwd: '/home/dev/a' },
      []
    )
    await discoverSkillsOnTarget(
      { kind: 'wsl', distro: 'Fedora', homeDir: '/home/dev', cwd: '/home/dev/a' },
      []
    )
    await discoverSkillsOnTarget(
      { kind: 'wsl', distro: 'Ubuntu', homeDir: '/home/dev', cwd: '/home/dev/b' },
      []
    )

    expect(wslScans).toHaveLength(3)
  })

  it('re-reads a WSL target when the caller refreshes', async () => {
    const target = {
      kind: 'wsl',
      distro: 'Ubuntu',
      homeDir: '/home/dev',
      cwd: '/home/dev/repo'
    } as const

    await discoverSkillsOnTarget(target, [])
    await discoverSkillsOnTarget(target, [], { refresh: true })
    await discoverSkillsOnTarget(target, [])

    // The refreshed result replaces the cached one, so the third call is free.
    expect(wslScans).toHaveLength(2)
  })

  it('drops the root cache too when the host clears its scans', () => {
    clearSkillDiscoveryCaches()
    expect(clearSkillRootScanCache).toHaveBeenCalled()
  })
})
