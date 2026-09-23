import { describe, expect, it, vi } from 'vitest'

const {
  createProfileStateStoreForStartupMock,
  orcadProfileStateAuthorityModeMock,
  emitMock,
  ensureActiveOrcaProfileMock,
  initOrcaProfilePathsMock,
  initSshHostKeyStoreFileMock
} = vi.hoisted(() => ({
  createProfileStateStoreForStartupMock: vi.fn(),
  orcadProfileStateAuthorityModeMock: vi.fn(),
  emitMock: vi.fn(),
  ensureActiveOrcaProfileMock: vi.fn(),
  initOrcaProfilePathsMock: vi.fn(),
  initSshHostKeyStoreFileMock: vi.fn()
}))

vi.mock('../persistence/profile-state/profile-state-startup-authority', () => ({
  createProfileStateStoreForStartup: createProfileStateStoreForStartupMock,
  orcadProfileStateAuthorityMode: orcadProfileStateAuthorityModeMock
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  ensureActiveOrcaProfile: ensureActiveOrcaProfileMock,
  initOrcaProfilePaths: initOrcaProfilePathsMock
}))
vi.mock('../ssh/ssh-host-key-store', () => ({
  initSshHostKeyStoreFile: initSshHostKeyStoreFileMock
}))
vi.mock('./orcad-profile-state-telemetry', () => ({
  emitOrcadProfileStateAuthoritySelected: emitMock
}))

const { createOrcadProfileStateStartup } = await import('./orcad-profile-state-startup')

describe('orcad profile-state startup', () => {
  it('selects the capable authority once and publishes bounded metadata', () => {
    const store = { getSettings: vi.fn() }
    ensureActiveOrcaProfileMock.mockReturnValue({
      dataFile: '/tmp/profile/orca-data.json',
      stateDatabaseFile: '/tmp/profile/profile-state.db',
      profile: { id: 'profile-1' }
    })
    orcadProfileStateAuthorityModeMock.mockReturnValue('sqlite-candidate')
    createProfileStateStoreForStartupMock.mockReturnValue({
      store,
      authority: { readSerializedState: vi.fn() },
      backend: 'sqlite',
      classification: 'json-only',
      migrated: true
    })

    const result = createOrcadProfileStateStartup('/tmp/user-data')

    expect(initOrcaProfilePathsMock).toHaveBeenCalledOnce()
    expect(ensureActiveOrcaProfileMock).toHaveBeenCalledWith('/tmp/user-data')
    expect(initSshHostKeyStoreFileMock).toHaveBeenCalledWith('/tmp/profile/orca-data.json')

    expect(createProfileStateStoreForStartupMock).toHaveBeenCalledWith({
      dataFile: '/tmp/profile/orca-data.json',
      databaseFile: '/tmp/profile/profile-state.db',
      profileId: 'profile-1',
      runtime: 'orcad',
      authorityMode: 'sqlite-candidate',
      storageAuthority: 'runtime'
    })
    expect(result.store).toBe(store)
    expect(result.authority).toEqual({
      backend: 'sqlite',
      classification: 'json-only',
      authority_mode: 'sqlite-candidate',
      runtime: 'orcad',
      migrated: true
    })
    expect(emitMock).toHaveBeenCalledWith(result.authority)
  })
})
