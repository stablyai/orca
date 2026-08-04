import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/types'

const { hydrateFailureDomainsMock, readOrcaYamlMock } = vi.hoisted(() => ({
  hydrateFailureDomainsMock: vi.fn(),
  readOrcaYamlMock: vi.fn()
}))

vi.mock('../filesystem-host/filesystem-host-read-authority', () => ({
  reconcileFilesystemHostFailureDomains: hydrateFailureDomainsMock,
  readOrcaYamlThroughFilesystemHost: readOrcaYamlMock
}))

import {
  orcaYamlSnapshots,
  OrcaYamlSnapshotStore,
  readFreshLocalOrcaYamlSnapshot,
  readLocalOrcaYamlSnapshot,
  reconcileLocalOrcaYamlSnapshots,
  refreshLocalOrcaYamlSnapshot,
  seedLocalOrcaYamlSnapshot
} from './orca-yaml-snapshot-store'

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo',
    name: 'Repo',
    path: '/repo',
    connectionId: null,
    executionHostId: 'local',
    ...overrides
  } as Repo
}

beforeEach(() => {
  orcaYamlSnapshots.resetForTests()
  hydrateFailureDomainsMock.mockReset()
  readOrcaYamlMock.mockReset()
  readOrcaYamlMock.mockResolvedValue('scripts:\n  setup: pnpm install\n')
})

describe('OrcaYamlSnapshotStore', () => {
  it('derives hook and shared-directory state from one content publication', () => {
    const store = new OrcaYamlSnapshotStore(() => 5)
    store.publishContent(
      '/repo',
      'scripts:\n  setup: pnpm install\nworktree:\n  sharedDirectories:\n    - node_modules\n'
    )

    expect(store.read('/repo')).toEqual({
      value: {
        contentState: 'valid',
        hooks: {
          scripts: { setup: 'pnpm install' },
          worktree: { sharedDirectories: ['node_modules'] }
        },
        mayNeedUpdate: false,
        sharedDirectories: ['node_modules']
      },
      stale: false,
      age: 0,
      availability: 'ready',
      lastError: null
    })
  })

  it('distinguishes missing, invalid, and unavailable', () => {
    const store = new OrcaYamlSnapshotStore()
    expect(store.read('/unavailable')).toMatchObject({
      value: null,
      stale: true,
      age: null,
      availability: 'unavailable'
    })

    store.publishContent('/missing', null)
    expect(store.read('/missing')).toMatchObject({
      stale: false,
      availability: 'missing',
      value: { contentState: 'missing' }
    })

    store.publishContent('/invalid', 'scripts: [')
    expect(store.read('/invalid')).toMatchObject({
      stale: false,
      availability: 'ready',
      value: { contentState: 'invalid' }
    })
  })

  it('keeps last-known content stale after a failed refresh', async () => {
    const store = new OrcaYamlSnapshotStore()
    store.publishContent('/repo', 'scripts:\n  setup: old\n')

    await store.refresh('/repo', () => Promise.reject(new Error('offline')))

    expect(store.read('/repo')).toMatchObject({
      stale: true,
      availability: 'unavailable',
      lastError: 'offline',
      value: { hooks: { scripts: { setup: 'old' } } }
    })
  })

  it('deduplicates refreshes and fences late data behind invalidation', async () => {
    const store = new OrcaYamlSnapshotStore()
    let resolveRead: (content: string | null) => void = () => {}
    const reader = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve
        })
    )
    const first = store.refresh('/repo', reader)
    const second = store.refresh('/repo', reader)
    expect(first).toBe(second)
    await Promise.resolve()

    store.invalidate('/repo')
    resolveRead('scripts:\n  setup: late\n')
    await first

    expect(store.read('/repo').availability).toBe('unavailable')
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('queues a current-generation read after invalidating an active refresh', async () => {
    const store = new OrcaYamlSnapshotStore()
    let resolveFirst: (content: string | null) => void = () => {}
    const reader = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce('scripts:\n  setup: current\n')

    const first = store.refresh('/repo', reader)
    await Promise.resolve()
    store.invalidate('/repo')
    const replacement = store.refresh('/repo', reader)
    expect(replacement).not.toBe(first)

    resolveFirst('scripts:\n  setup: stale\n')
    await replacement

    expect(reader).toHaveBeenCalledTimes(2)
    expect(store.read('/repo')).toMatchObject({
      stale: false,
      availability: 'ready',
      value: { hooks: { scripts: { setup: 'current' } } }
    })
  })

  it('does not resurrect a removed repo from an in-flight refresh', async () => {
    const store = new OrcaYamlSnapshotStore()
    let resolveRead: (content: string | null) => void = () => {}
    const refresh = store.refresh(
      '/removed',
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        })
    )
    await Promise.resolve()

    store.remove('/removed')
    expect(store.retainedRemovalGenerationCountForTests()).toBe(1)
    resolveRead('scripts:\n  setup: late\n')
    await refresh

    expect(store.retainedRemovalGenerationCountForTests()).toBe(0)
    expect(store.read('/removed')).toMatchObject({
      value: null,
      stale: true,
      availability: 'unavailable'
    })
  })

  it('classifies permission failures as denied', async () => {
    const store = new OrcaYamlSnapshotStore()
    const error = Object.assign(new Error('permission denied'), { code: 'EPERM' })

    await store.refresh('/repo', () => Promise.reject(error))

    expect(store.read('/repo')).toMatchObject({
      value: null,
      stale: true,
      availability: 'denied',
      lastError: 'permission denied'
    })
  })

  it('revalidates an aged local snapshot without blocking its memory read', async () => {
    vi.useFakeTimers({ now: 1 })
    try {
      readOrcaYamlMock
        .mockResolvedValueOnce('scripts:\n  setup: old\n')
        .mockResolvedValueOnce('scripts:\n  setup: current\n')
      await refreshLocalOrcaYamlSnapshot('/repo')
      vi.setSystemTime(30_002)

      expect(readLocalOrcaYamlSnapshot('/repo').value?.hooks).toEqual({
        scripts: { setup: 'old' }
      })
      await refreshLocalOrcaYamlSnapshot('/repo')
      expect(orcaYamlSnapshots.read('/repo').value?.hooks).toEqual({
        scripts: { setup: 'current' }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('revalidates trust snapshots even when the cached value is recent', async () => {
    readOrcaYamlMock
      .mockResolvedValueOnce('scripts:\n  archive: old\n')
      .mockResolvedValueOnce('scripts:\n  archive: current\n')
    await refreshLocalOrcaYamlSnapshot('/repo')

    await expect(readFreshLocalOrcaYamlSnapshot('/repo')).resolves.toMatchObject({
      stale: false,
      value: { hooks: { scripts: { archive: 'current' } } }
    })
  })

  it('marks only valid unknown-key-only content as needing an update', () => {
    const store = new OrcaYamlSnapshotStore()
    store.publishContent('/repo', 'futureFeature:\n  enabled: true\n')
    expect(store.read('/repo').value).toMatchObject({
      contentState: 'valid',
      mayNeedUpdate: true
    })
  })

  it('seeds local Git and WSL repos without reading folder or SSH paths', async () => {
    seedLocalOrcaYamlSnapshot(repo({ path: '/local/repo' }))
    seedLocalOrcaYamlSnapshot(repo({ id: 'folder', kind: 'folder', path: '/local/folder' }))
    seedLocalOrcaYamlSnapshot(
      repo({ id: 'ssh', path: '/remote/repo', connectionId: 'ssh-1', executionHostId: null })
    )
    seedLocalOrcaYamlSnapshot(repo({ id: 'wsl', path: '\\\\wsl.localhost\\Ubuntu\\home\\repo' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(readOrcaYamlMock).toHaveBeenCalledTimes(2)
    expect(readOrcaYamlMock.mock.calls.map(([filePath]) => String(filePath))).toEqual([
      '/local/repo/orca.yaml',
      '\\\\wsl.localhost\\Ubuntu\\home\\repo/orca.yaml'
    ])
  })

  it('refreshes local failure-domain prefixes without classifying SSH paths', () => {
    reconcileLocalOrcaYamlSnapshots([
      repo({ path: '/local/repo' }),
      repo({ id: 'folder', kind: 'folder', path: '/local/folder' }),
      repo({ id: 'wsl', path: String.raw`\\wsl.localhost\Ubuntu\home\repo` }),
      repo({ id: 'ssh', path: '/remote/repo', connectionId: 'ssh-1', executionHostId: null })
    ])

    expect(hydrateFailureDomainsMock).toHaveBeenCalledWith([
      '/local/repo',
      '/local/folder',
      String.raw`\\wsl.localhost\Ubuntu\home\repo`
    ])
  })

  it('hydrates a repo added after startup and removes its snapshot after deletion', async () => {
    const addedRepo = repo({ path: '/added/repo' })

    reconcileLocalOrcaYamlSnapshots([addedRepo])
    await vi.waitFor(() => {
      expect(orcaYamlSnapshots.read(addedRepo.path)).toMatchObject({
        stale: false,
        availability: 'ready',
        value: { hooks: { scripts: { setup: 'pnpm install' } } }
      })
    })

    reconcileLocalOrcaYamlSnapshots([])

    expect(orcaYamlSnapshots.has(addedRepo.path)).toBe(false)
    expect(orcaYamlSnapshots.read(addedRepo.path)).toMatchObject({
      value: null,
      stale: true,
      availability: 'unavailable'
    })
  })

  it('starts a fresh read when a removed path is re-added before its first read settles', async () => {
    const readdedRepo = repo({ path: '/readded/repo' })
    let resolveFirstRead: (content: string) => void = () => {}
    readOrcaYamlMock
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirstRead = resolve
          })
      )
      .mockResolvedValueOnce('scripts:\n  setup: new\n')

    reconcileLocalOrcaYamlSnapshots([readdedRepo])
    await vi.waitFor(() => expect(readOrcaYamlMock).toHaveBeenCalledTimes(1))
    reconcileLocalOrcaYamlSnapshots([])
    reconcileLocalOrcaYamlSnapshots([readdedRepo])

    await vi.waitFor(() => {
      expect(readOrcaYamlMock).toHaveBeenCalledTimes(2)
      expect(orcaYamlSnapshots.read(readdedRepo.path).value?.hooks).toEqual({
        scripts: { setup: 'new' }
      })
    })

    resolveFirstRead('scripts:\n  setup: old\n')
    await Promise.resolve()
    await Promise.resolve()
    expect(orcaYamlSnapshots.read(readdedRepo.path).value?.hooks).toEqual({
      scripts: { setup: 'new' }
    })
  })
})
