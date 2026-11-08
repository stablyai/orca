import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillDiscoveryResult } from '../../shared/skills'
import type { Repo } from '../../shared/repo-types'

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
  discoverSkillObservationInWsl: vi.fn(async (args: unknown) => {
    wslScans.push(args)
    return { rows: [], sources: [], scannedAt: 1 }
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

  // Repo order must not change the key: with TTL 0, only equal keys coalesce concurrent callers.
  it('keeps repo-list identity stable regardless of stored order', async () => {
    const repos = [makeRepo('/repo-a'), makeRepo('/repo-b')]
    await discoverSkillsOnTarget({ kind: 'native-host', cwd: undefined }, repos)
    await Promise.all([
      discoverSkillsOnTarget({ kind: 'native-host', cwd: undefined }, repos.toReversed()),
      discoverSkillsOnTarget({ kind: 'native-host', cwd: undefined }, repos)
    ])

    expect(nativeScans).toHaveLength(2)
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

    expect(wslScans).toHaveLength(2)
  })
})
