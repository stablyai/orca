import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshConnectionStore } from './ssh-connection-store'
import { createMockStore } from './testing/ssh-connection-store-test-fixture'
import type { SshTarget } from '../../../shared/remote-runtime/ssh/ssh-types'

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
  })
})
