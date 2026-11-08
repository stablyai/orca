import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshConnectionStore } from './ssh-connection-store'
import { createMockStore } from './ssh-connection-store-test-fixture'
import type { SshTarget } from '../../../shared/ssh-types'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../config/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  loadUserSshConfigWithText: () => {
    const hosts = loadUserSshConfigMock()
    return { hosts, text: JSON.stringify(hosts ?? []) }
  },
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))

describe('SshConnectionStore', () => {
  let mockStore: ReturnType<typeof createMockStore>
  let sshStore: SshConnectionStore

  beforeEach(() => {
    mockStore = createMockStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the Store methods SshConnectionStore calls.
    sshStore = new SshConnectionStore(mockStore as never, { config: async () => null })
    loadUserSshConfigMock.mockReset()
    sshConfigHostsToTargetsMock.mockReset()
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

  it('clears the runtime ladder decision when the runtime choice or endpoint changes', () => {
    const resolution = {
      rung: 'legacy' as const,
      pinnedRefusal: 'missing_lib',
      glibc: '2.31',
      runtimeSha256: 'a'.repeat(64),
      orcaMajor: 1
    }
    mockStore.addSshTarget({
      id: 'ssh-ladder',
      label: 'Ladder',
      host: 'ladder.example.com',
      port: 22,
      username: 'user',
      remoteRuntime: 'pinned-node',
      remoteRuntimeResolution: resolution
    })

    sshStore.updateTarget('ssh-ladder', { label: 'Renamed', remoteRuntime: 'pinned-node' })
    expect(mockStore.updateSshTarget).toHaveBeenLastCalledWith('ssh-ladder', {
      label: 'Renamed',
      remoteRuntime: 'pinned-node'
    })

    sshStore.updateTarget('ssh-ladder', { remoteRuntime: 'legacy' })
    expect(mockStore.updateSshTarget).toHaveBeenLastCalledWith('ssh-ladder', {
      remoteRuntime: 'legacy',
      remoteRuntimeResolution: undefined
    })

    sshStore.updateTarget('ssh-ladder', { remoteRuntimeResolution: resolution })
    sshStore.updateTarget('ssh-ladder', { host: 'other.example.com' })
    expect(mockStore.updateSshTarget).toHaveBeenLastCalledWith('ssh-ladder', {
      host: 'other.example.com',
      remoteRuntimeResolution: undefined
    })
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

    it('refreshes host, username, and jump host on sync, not just port', async () => {
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

      await sshStore.importFromSshConfig()

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

    it('adopts a legacy unsourced target into config-sync', async () => {
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

      const result = (await sshStore.importFromSshConfig()).targets

      expect(mockStore.updateSshTarget).toHaveBeenCalledWith(
        'ssh-legacy',
        expect.objectContaining({ port: 2222, source: 'ssh-config' })
      )
      expect(result[0].source).toBe('ssh-config')
    })

    it('does not overwrite a legacy unsourced manual target with the same alias', async () => {
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

      const result = (await sshStore.importFromSshConfig()).targets

      expect(mockStore.updateSshTarget).not.toHaveBeenCalled()
      expect(mockStore.addSshTarget).toHaveBeenCalledTimes(1)
      expect(result).toEqual([])
    })

    // Import alias ownership must use the picker's case-insensitive Host matching.
    it('treats a case-only alias variant as owned by the existing manual target', async () => {
      mockStore.addSshTarget({
        id: 'ssh-m',
        label: 'Prod',
        configHost: 'Prod',
        host: 'manual.example.com',
        port: 22,
        username: 'me',
        source: 'manual'
      })
      loadUserSshConfigMock.mockReturnValue([{ host: 'prod' }])
      sshConfigHostsToTargetsMock.mockReturnValue([candidate({ configHost: 'prod' })])

      const result = (await sshStore.importFromSshConfig()).targets

      expect(mockStore.addSshTarget).toHaveBeenCalledTimes(1)
      expect(result).toEqual([])
    })

    it('keeps a case-only alias variant suppressed after the host was deleted', async () => {
      const added = sshStore.addTarget({
        label: 'Prod',
        configHost: 'Prod',
        host: 'prod.example.com',
        port: 22,
        username: 'me'
      })
      sshStore.removeTarget(added.id)
      loadUserSshConfigMock.mockReturnValue([{ host: 'prod' }])
      sshConfigHostsToTargetsMock.mockReturnValue([candidate({ configHost: 'prod' })])

      const result = (await sshStore.importFromSshConfig()).targets

      expect(result).toEqual([])
      expect(mockStore.addSshTarget).toHaveBeenCalledTimes(1)
    })

    it('lifts a tombstone stored under different casing when the host is re-added', () => {
      const added = sshStore.addTarget({
        label: 'Prod',
        configHost: 'Prod',
        host: 'prod.example.com',
        port: 22,
        username: 'me'
      })
      sshStore.removeTarget(added.id)
      sshStore.addTarget({
        label: 'prod',
        configHost: 'prod',
        host: 'prod.example.com',
        port: 22,
        username: 'me'
      })

      expect(sshStore.listSuppressedSshConfigAliases()).toEqual([])
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

    it('reAdopt clears all tombstones and re-imports the deleted host', async () => {
      mockStore.addDeletedSshConfigAlias('mini')
      loadUserSshConfigMock.mockReturnValue([{ host: 'mini' }])
      sshConfigHostsToTargetsMock.mockReturnValue([candidate({ configHost: 'mini' })])

      const result = (await sshStore.importFromSshConfig({ reAdopt: true })).targets

      expect(mockStore.clearDeletedSshConfigAliases).toHaveBeenCalled()
      expect(mockStore.addSshTarget).toHaveBeenCalledWith(
        expect.objectContaining({ configHost: 'mini', source: 'ssh-config' })
      )
      expect(result).toHaveLength(1)
    })

    it('reports every exact repo migration from a multi-host re-import', async () => {
      mockStore.addRemovedSshTargetTombstone({
        oldTargetId: 'ssh-old-a',
        configHost: 'host-a',
        host: 'host-a.example.com',
        port: 22,
        username: '',
        label: 'host-a',
        removedAt: 1
      })
      mockStore.addRemovedSshTargetTombstone({
        oldTargetId: 'ssh-old-b',
        configHost: 'host-b',
        host: 'host-b.example.com',
        port: 22,
        username: '',
        label: 'host-b',
        removedAt: 1
      })
      loadUserSshConfigMock.mockReturnValue([{ host: 'host-a' }, { host: 'host-b' }])
      sshConfigHostsToTargetsMock.mockReturnValue([
        candidate({ configHost: 'host-a' }),
        candidate({ configHost: 'host-b' })
      ])

      const { repoReadoptions } = await sshStore.importFromSshConfig({ reAdopt: true })

      expect(repoReadoptions).toEqual([
        { oldTargetId: 'ssh-old-a', newTargetId: 'tmp-host-a', repoIds: ['repo-1'] },
        { oldTargetId: 'ssh-old-b', newTargetId: 'tmp-host-b', repoIds: ['repo-1'] }
      ])
    })
  })

  describe('re-adoption of orphaned workspaces', () => {
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
      expect(mockStore.addDeletedSshConfigAlias).not.toHaveBeenCalled()
    })

    // Exercise real remove/re-add so default configHost participates in tombstone readoption.
    it('re-adopts through an actual removeTarget then re-add of the same host', () => {
      const added = sshStore.addTarget({
        label: 'Dev',
        host: 'dev.example.com',
        port: 22,
        username: 'tim'
      })
      sshStore.removeTarget(added.id)
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
      expect(sshStore.lastRepoReadoptions).toEqual([
        { oldTargetId: added.id, newTargetId: readded.id, repoIds: ['repo-1'] }
      ])
    })

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
      expect(sshStore.lastRepoReadoptions).toEqual([])
    })
  })
})
