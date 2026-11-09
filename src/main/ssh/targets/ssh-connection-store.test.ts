import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshConnectionStore } from './ssh-connection-store'
import { createMockStore } from './testing/ssh-connection-store-test-fixture'
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
  })

  describe('re-adoption of orphaned workspaces', () => {
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
