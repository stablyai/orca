import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshConnectionStore } from './ssh-connection-store'
import type { RemovedSshTargetTombstone, SshTarget } from '../../shared/ssh-types'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))

function createMockStore() {
  const targets: SshTarget[] = []
  let deletedAliases: string[] = []
  const removedTombstones: RemovedSshTargetTombstone[] = []
  const reassignments: { oldTargetId: string; newTargetId: string }[] = []

  return {
    getSshTargets: vi.fn(() => [...targets]),
    getSshTarget: vi.fn((id: string) => targets.find((t) => t.id === id)),
    addSshTarget: vi.fn((target: SshTarget) => targets.push(target)),
    updateSshTarget: vi.fn((id: string, updates: Partial<Omit<SshTarget, 'id'>>) => {
      const target = targets.find((t) => t.id === id)
      if (!target) {
        return null
      }
      Object.assign(target, updates)
      return { ...target }
    }),
    removeSshTarget: vi.fn((id: string) => {
      const idx = targets.findIndex((t) => t.id === id)
      if (idx !== -1) {
        targets.splice(idx, 1)
      }
    }),
    getDeletedSshConfigAliases: vi.fn(() => [...deletedAliases]),
    addDeletedSshConfigAlias: vi.fn((alias: string) => {
      if (!deletedAliases.includes(alias)) {
        deletedAliases.push(alias)
      }
    }),
    removeDeletedSshConfigAlias: vi.fn((alias: string) => {
      deletedAliases = deletedAliases.filter((entry) => entry !== alias)
    }),
    clearDeletedSshConfigAliases: vi.fn(() => {
      deletedAliases = []
    }),
    removedTombstones,
    reassignments,
    getRemovedSshTargetTombstones: vi.fn(() => [...removedTombstones]),
    addRemovedSshTargetTombstone: vi.fn((tombstone: RemovedSshTargetTombstone) => {
      const filtered = removedTombstones.filter((t) => t.oldTargetId !== tombstone.oldTargetId)
      removedTombstones.length = 0
      removedTombstones.push(...filtered, tombstone)
    }),
    removeRemovedSshTargetTombstone: vi.fn((oldTargetId: string) => {
      const kept = removedTombstones.filter((t) => t.oldTargetId !== oldTargetId)
      removedTombstones.length = 0
      removedTombstones.push(...kept)
    }),
    reassignSshTargetId: vi.fn((oldTargetId: string, newTargetId: string) => {
      reassignments.push({ oldTargetId, newTargetId })
      // Pretend one repo referenced the old id.
      return 1
    })
  }
}

describe('SshConnectionStore', () => {
  let mockStore: ReturnType<typeof createMockStore>
  let sshStore: SshConnectionStore

  beforeEach(() => {
    mockStore = createMockStore()
    sshStore = new SshConnectionStore(mockStore as never)
    loadUserSshConfigMock.mockReset()
    sshConfigHostsToTargetsMock.mockReset()
  })

  it('listTargets delegates to store', () => {
    sshStore.listTargets()
    expect(mockStore.getSshTargets).toHaveBeenCalled()
  })

  it('getTarget delegates to store', () => {
    sshStore.getTarget('test-id')
    expect(mockStore.getSshTarget).toHaveBeenCalledWith('test-id')
  })

  it('addTarget generates an id and persists', () => {
    const target = sshStore.addTarget({
      label: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    })

    expect(target.id).toMatch(/^ssh-/)
    expect(target.label).toBe('My Server')
    expect(mockStore.addSshTarget).toHaveBeenCalledWith(target)
  })

  it('addTarget stamps source as manual by default', () => {
    const target = sshStore.addTarget({
      label: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    })
    expect(target.source).toBe('manual')
  })

  it('addTarget preserves an explicitly provided source', () => {
    const target = sshStore.addTarget({
      label: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      source: 'ssh-config'
    })
    expect(target.source).toBe('ssh-config')
  })

  it('hides runtime-owned targets from normal target lists', () => {
    const userTarget = sshStore.addTarget({
      label: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    })
    sshStore.upsertRuntimeOwnedTarget('runtime-1', {
      label: 'Sandbox',
      host: 'sandbox.example.com',
      port: 22,
      username: 'root'
    })

    expect(sshStore.listTargets()).toEqual([userTarget])
  })

  it('updateTarget delegates to store', () => {
    const original: SshTarget = {
      id: 'ssh-1',
      label: 'Old Name',
      host: 'example.com',
      port: 22,
      username: 'user'
    }
    mockStore.addSshTarget(original)

    const result = sshStore.updateTarget('ssh-1', { label: 'New Name' })
    expect(result).toBeTruthy()
    expect(mockStore.updateSshTarget).toHaveBeenCalledWith('ssh-1', { label: 'New Name' })
  })

  it('removeTarget delegates to store', () => {
    sshStore.removeTarget('ssh-1')
    expect(mockStore.removeSshTarget).toHaveBeenCalledWith('ssh-1')
  })

  describe('importFromSshConfig', () => {
    function candidate(overrides: Partial<SshTarget> & { configHost: string }): SshTarget {
      return {
        id: `tmp-${overrides.configHost}`,
        label: overrides.configHost,
        host: `${overrides.configHost}.example.com`,
        port: 22,
        username: '',
        ...overrides
      }
    }

    it('inserts a new config host stamped as ssh-config', () => {
      loadUserSshConfigMock.mockReturnValue([{ host: 'staging' }])
      sshConfigHostsToTargetsMock.mockReturnValue([
        candidate({ configHost: 'staging', host: 'staging.example.com' })
      ])

      const result = sshStore.importFromSshConfig()

      expect(mockStore.addSshTarget).toHaveBeenCalledWith(
        expect.objectContaining({ configHost: 'staging', source: 'ssh-config' })
      )
      expect(result).toHaveLength(1)
      expect(result[0].source).toBe('ssh-config')
    })

    it('asks the parser for all hosts — reconciliation happens in the store', () => {
      loadUserSshConfigMock.mockReturnValue([{ host: 'a' }])
      sshConfigHostsToTargetsMock.mockReturnValue([])

      sshStore.importFromSshConfig()

      expect(sshConfigHostsToTargetsMock).toHaveBeenCalledWith([{ host: 'a' }], new Set())
    })

    // PRIMARY regression (#4684 item #1): a rotated port must take effect on
    // re-import instead of silently keeping the stale value.
    it('updates an existing config-sourced target when the port changed', () => {
      mockStore.addSshTarget({
        id: 'ssh-1',
        label: 'cluster',
        configHost: 'cluster',
        host: '10.0.0.5',
        port: 2200,
        username: 'dev',
        source: 'ssh-config'
      })
      loadUserSshConfigMock.mockReturnValue([{ host: 'cluster' }])
      sshConfigHostsToTargetsMock.mockReturnValue([
        candidate({ configHost: 'cluster', host: '10.0.0.5', port: 2222, username: 'dev' })
      ])

      const result = sshStore.importFromSshConfig()

      expect(mockStore.updateSshTarget).toHaveBeenCalledWith(
        'ssh-1',
        expect.objectContaining({ port: 2222, source: 'ssh-config' })
      )
      // Only the seed insert — no duplicate target created.
      expect(mockStore.addSshTarget).toHaveBeenCalledTimes(1)
      expect(result).toHaveLength(1)
      expect(result[0].port).toBe(2222)
    })

    it('refreshes host, username, and jump host on sync, not just port', () => {
      mockStore.addSshTarget({
        id: 'ssh-1',
        label: 'box',
        configHost: 'box',
        host: 'old.example.com',
        port: 22,
        username: 'old',
        source: 'ssh-config'
      })
      loadUserSshConfigMock.mockReturnValue([{ host: 'box' }])
      sshConfigHostsToTargetsMock.mockReturnValue([
        candidate({
          configHost: 'box',
          host: 'new.example.com',
          port: 2200,
          username: 'newuser',
          jumpHost: 'bastion'
        })
      ])

      sshStore.importFromSshConfig()

      expect(mockStore.updateSshTarget).toHaveBeenCalledWith(
        'ssh-1',
        expect.objectContaining({
          host: 'new.example.com',
          port: 2200,
          username: 'newuser',
          jumpHost: 'bastion'
        })
      )
    })

    it('never overwrites a manual target that owns the alias', () => {
      mockStore.addSshTarget({
        id: 'ssh-m',
        label: 'cluster',
        configHost: 'cluster',
        host: 'manual.example.com',
        port: 22,
        username: 'me',
        source: 'manual'
      })
      loadUserSshConfigMock.mockReturnValue([{ host: 'cluster' }])
      sshConfigHostsToTargetsMock.mockReturnValue([
        candidate({ configHost: 'cluster', host: '10.0.0.9', port: 2222, username: 'dev' })
      ])

      const result = sshStore.importFromSshConfig()

      expect(mockStore.updateSshTarget).not.toHaveBeenCalled()
      // Only the manual seed insert — the config alias is not duplicated.
      expect(mockStore.addSshTarget).toHaveBeenCalledTimes(1)
      expect(result).toEqual([])
    })

    it('adopts a legacy unsourced target into config-sync', () => {
      mockStore.addSshTarget({
        id: 'ssh-legacy',
        label: 'cluster',
        configHost: 'cluster',
        host: '10.0.0.5',
        port: 2200,
        username: 'dev'
        // no source — predates the field
      })
      loadUserSshConfigMock.mockReturnValue([{ host: 'cluster' }])
      sshConfigHostsToTargetsMock.mockReturnValue([
        candidate({ configHost: 'cluster', host: '10.0.0.5', port: 2222, username: 'dev' })
      ])

      const result = sshStore.importFromSshConfig()

      expect(mockStore.updateSshTarget).toHaveBeenCalledWith(
        'ssh-legacy',
        expect.objectContaining({ port: 2222, source: 'ssh-config' })
      )
      expect(result[0].source).toBe('ssh-config')
    })

    it('does not overwrite a legacy unsourced manual target with the same alias', () => {
      mockStore.addSshTarget({
        id: 'ssh-legacy-manual',
        label: 'cluster',
        configHost: 'cluster',
        host: 'cluster',
        port: 2200,
        username: 'me'
        // no source — predates the field, but does not look like a config import
      })
      loadUserSshConfigMock.mockReturnValue([{ host: 'cluster' }])
      sshConfigHostsToTargetsMock.mockReturnValue([
        candidate({ configHost: 'cluster', host: '10.0.0.5', port: 2222, username: 'dev' })
      ])

      const result = sshStore.importFromSshConfig()

      expect(mockStore.updateSshTarget).not.toHaveBeenCalled()
      expect(mockStore.addSshTarget).toHaveBeenCalledTimes(1)
      expect(result).toEqual([])
    })

    it('does not rewrite an unchanged config-sourced target', () => {
      mockStore.addSshTarget({
        id: 'ssh-1',
        label: 'cluster',
        configHost: 'cluster',
        host: 'cluster.example.com',
        port: 22,
        username: '',
        source: 'ssh-config'
      })
      loadUserSshConfigMock.mockReturnValue([{ host: 'cluster' }])
      // Candidate is identical to the persisted target (same default fields).
      sshConfigHostsToTargetsMock.mockReturnValue([candidate({ configHost: 'cluster' })])

      const result = sshStore.importFromSshConfig()

      expect(mockStore.updateSshTarget).not.toHaveBeenCalled()
      expect(result).toEqual([])
    })

    it('returns empty array when nothing changed', () => {
      loadUserSshConfigMock.mockReturnValue([])
      sshConfigHostsToTargetsMock.mockReturnValue([])

      const result = sshStore.importFromSshConfig()
      expect(result).toEqual([])
    })
  })

  describe('deleted config host tombstones', () => {
    function candidate(overrides: Partial<SshTarget> & { configHost: string }): SshTarget {
      return {
        id: `tmp-${overrides.configHost}`,
        label: overrides.configHost,
        host: `${overrides.configHost}.example.com`,
        port: 22,
        username: '',
        ...overrides
      }
    }

    // PRIMARY regression: deleting a config-sourced host must not let the next
    // ~/.ssh/config sync resurrect it.
    it('tombstones a deleted config-sourced host so re-import skips it', () => {
      mockStore.addSshTarget({
        id: 'ssh-1',
        label: 'mini',
        configHost: 'mini',
        host: 'mini.example.com',
        port: 22,
        username: 'ping',
        source: 'ssh-config'
      })

      sshStore.removeTarget('ssh-1')
      expect(mockStore.addDeletedSshConfigAlias).toHaveBeenCalledWith('mini')

      loadUserSshConfigMock.mockReturnValue([{ host: 'mini' }])
      sshConfigHostsToTargetsMock.mockReturnValue([candidate({ configHost: 'mini' })])

      const result = sshStore.importFromSshConfig()

      expect(mockStore.addSshTarget).toHaveBeenCalledTimes(1) // only the seed insert
      expect(result).toEqual([])
    })

    it('does not tombstone a manual target on delete', () => {
      mockStore.addSshTarget({
        id: 'ssh-1',
        label: 'mini',
        configHost: 'mini',
        host: 'mini.example.com',
        port: 22,
        username: 'ping',
        source: 'manual'
      })

      sshStore.removeTarget('ssh-1')
      expect(mockStore.addDeletedSshConfigAlias).not.toHaveBeenCalled()
    })

    it('re-adding a deleted host reclaims its alias so sync stops suppressing it', () => {
      mockStore.addDeletedSshConfigAlias('mini')

      sshStore.addTarget({
        label: 'mini',
        configHost: 'mini',
        host: '10.0.0.2',
        port: 22,
        username: 'ping'
      })
      expect(mockStore.removeDeletedSshConfigAlias).toHaveBeenCalledWith('mini')

      loadUserSshConfigMock.mockReturnValue([{ host: 'mini' }])
      sshConfigHostsToTargetsMock.mockReturnValue([candidate({ configHost: 'mini' })])
      // Alias reclaimed, but it is now a manual target — still not re-inserted.
      const result = sshStore.importFromSshConfig()
      expect(result).toEqual([])
    })

    it('editing a target reclaims its alias from the deleted set', () => {
      mockStore.addSshTarget({
        id: 'ssh-1',
        label: 'mini',
        configHost: 'mini',
        host: 'mini.example.com',
        port: 22,
        username: 'ping',
        source: 'ssh-config'
      })
      mockStore.addDeletedSshConfigAlias('mini')

      sshStore.updateTarget('ssh-1', { port: 2222, source: 'manual' })
      expect(mockStore.removeDeletedSshConfigAlias).toHaveBeenCalledWith('mini')
    })

    it('reAdopt clears all tombstones and re-imports the deleted host', () => {
      mockStore.addDeletedSshConfigAlias('mini')
      loadUserSshConfigMock.mockReturnValue([{ host: 'mini' }])
      sshConfigHostsToTargetsMock.mockReturnValue([candidate({ configHost: 'mini' })])

      const result = sshStore.importFromSshConfig({ reAdopt: true })

      expect(mockStore.clearDeletedSshConfigAliases).toHaveBeenCalled()
      expect(mockStore.addSshTarget).toHaveBeenCalledWith(
        expect.objectContaining({ configHost: 'mini', source: 'ssh-config' })
      )
      expect(result).toHaveLength(1)
    })
  })

  describe('re-adoption of orphaned workspaces', () => {
    it('records a tombstone when removing any user-facing target', () => {
      mockStore.addSshTarget({
        id: 'ssh-1',
        label: 'Dev',
        host: 'dev.example.com',
        port: 22,
        username: 'tim',
        source: 'manual'
      })

      sshStore.removeTarget('ssh-1')

      expect(mockStore.addRemovedSshTargetTombstone).toHaveBeenCalledWith(
        expect.objectContaining({
          oldTargetId: 'ssh-1',
          host: 'dev.example.com',
          port: 22,
          username: 'tim'
        })
      )
    })

    it('does not tombstone runtime-owned targets', () => {
      mockStore.addSshTarget({
        id: 'runtime-ssh-abc',
        label: 'VM',
        host: 'vm.example.com',
        port: 22,
        username: 'tim',
        owner: { type: 'on-demand-runtime', runtimeId: 'abc' }
      })

      sshStore.removeTarget('runtime-ssh-abc')

      expect(mockStore.addRemovedSshTargetTombstone).not.toHaveBeenCalled()
    })

    it('re-adopts orphaned repos when the same host is re-added', () => {
      // Simulate a prior removal by seeding a matching tombstone.
      mockStore.addRemovedSshTargetTombstone({
        oldTargetId: 'ssh-old',
        host: 'dev.example.com',
        port: 22,
        username: 'tim',
        label: 'Dev',
        removedAt: 1
      })

      sshStore.addTarget({
        label: 'Dev',
        host: 'dev.example.com',
        port: 22,
        username: 'tim'
      })

      expect(mockStore.reassignSshTargetId).toHaveBeenCalledTimes(1)
      const [oldId, newId] = mockStore.reassignSshTargetId.mock.calls[0]
      expect(oldId).toBe('ssh-old')
      expect(newId).toMatch(/^ssh-/)
      // Re-adoption count surfaces so the IPC layer can refresh the repo list.
      expect(sshStore.lastReadoptedRepoCount).toBe(1)
    })

    // Why: drive the real remove→re-add path so the tombstone carries the
    // defaulted configHost (host) that buildRemovedSshTargetTombstone produces,
    // rather than a hand-seeded tombstone without one.
    it('re-adopts through an actual removeTarget then re-add of the same host', () => {
      const added = sshStore.addTarget({
        label: 'Dev',
        host: 'dev.example.com',
        port: 22,
        username: 'tim'
      })
      sshStore.removeTarget(added.id)
      // The tombstone was built from the real target (configHost defaulted to host).
      const tombstones = mockStore.getRemovedSshTargetTombstones()
      expect(tombstones).toHaveLength(1)
      expect(tombstones[0]).toMatchObject({ oldTargetId: added.id, configHost: 'dev.example.com' })

      mockStore.reassignSshTargetId.mockClear()
      const readded = sshStore.addTarget({
        label: 'Dev',
        host: 'dev.example.com',
        port: 22,
        username: 'tim'
      })

      expect(mockStore.reassignSshTargetId).toHaveBeenCalledWith(added.id, readded.id)
      expect(sshStore.lastReadoptedRepoCount).toBe(1)
    })

    // A different account on the SAME host must NOT re-adopt, even though both
    // manual adds default configHost to the shared hostname.
    it('does not re-adopt a different account on the same host', () => {
      const alice = sshStore.addTarget({
        label: 'alice',
        host: 'dev.example.com',
        port: 22,
        username: 'alice'
      })
      sshStore.removeTarget(alice.id)
      mockStore.reassignSshTargetId.mockClear()

      sshStore.addTarget({
        label: 'bob',
        host: 'dev.example.com',
        port: 2222,
        username: 'bob'
      })

      expect(mockStore.reassignSshTargetId).not.toHaveBeenCalled()
    })

    it('does not re-adopt when the re-added host identity differs', () => {
      mockStore.addRemovedSshTargetTombstone({
        oldTargetId: 'ssh-old',
        host: 'other.example.com',
        port: 22,
        username: 'root',
        label: 'Other',
        removedAt: 1
      })

      sshStore.addTarget({
        label: 'Dev',
        host: 'dev.example.com',
        port: 22,
        username: 'tim'
      })

      expect(mockStore.reassignSshTargetId).not.toHaveBeenCalled()
      expect(sshStore.lastReadoptedRepoCount).toBe(0)
    })
  })
})
