import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createManagedOrcadSshOwner } from '../../shared/managed-orcad-ssh-owner'
import { isRuntimeOwnedSshTarget, SshConnectionStore } from './ssh-connection-store'
import { createMockStore } from './ssh-connection-store-test-fixture'
import { emptyDependentStateStore } from './ssh-target-orcad-dependents-fixture'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))

const base = { label: 'cluster', host: 'cluster.example.com', port: 22, username: 'dev' }

describe('managed orcad ownership of SSH targets', () => {
  let mockStore: ReturnType<typeof createMockStore>
  let sshStore: SshConnectionStore

  beforeEach(() => {
    mockStore = Object.assign(createMockStore(), emptyDependentStateStore())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the store methods SshConnectionStore calls.
    sshStore = new SshConnectionStore(mockStore as never)
    loadUserSshConfigMock.mockReset()
    sshConfigHostsToTargetsMock.mockReset()
  })

  it('hides claimed and provisioning targets from direct SSH lists', () => {
    const visible = sshStore.addTarget(base)
    sshStore.addTarget({
      ...base,
      label: 'provisioning',
      orcadProvisioning: { requestId: 'r', name: 'n' }
    })
    const claimed = sshStore.addTarget({ ...base, label: 'claimed' })
    sshStore.getOrcadRuntimeClaims().claim(claimed.id, 'environment-1')

    expect(sshStore.listTargets()).toEqual([visible])
    expect(sshStore.getOrcadRuntimeClaims().listTargets()).toHaveLength(3)
  })

  it('keeps ~/.ssh/config sync from rewriting a claimed config-sourced host', () => {
    mockStore.addSshTarget({
      ...base,
      id: 'ssh-config-host',
      configHost: 'cluster',
      source: 'ssh-config',
      owner: createManagedOrcadSshOwner('environment-1')
    })
    loadUserSshConfigMock.mockReturnValue([{ host: 'cluster' }])
    sshConfigHostsToTargetsMock.mockReturnValue([
      { ...base, id: 'tmp', configHost: 'cluster', host: '10.0.0.9', port: 2222 }
    ])

    expect(sshStore.importFromSshConfig()).toEqual([])
    expect(mockStore.updateSshTarget).not.toHaveBeenCalled()
  })

  it('treats ownership or a provisioning intent as runtime-owned', () => {
    const target = { ...base, id: 'ssh-1' }
    expect(isRuntimeOwnedSshTarget(target)).toBe(false)
    expect(
      isRuntimeOwnedSshTarget({ ...target, orcadProvisioning: { requestId: 'r', name: 'n' } })
    ).toBe(true)
    expect(isRuntimeOwnedSshTarget({ ...target, owner: createManagedOrcadSshOwner('e') })).toBe(
      true
    )
  })
})
