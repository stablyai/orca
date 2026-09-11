import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveOrcaProfileState } from './profile-index-store'
import type { OrcaCloudSessionReadResult } from './profile-cloud-session-store'
import { getOrcaProfileAuthStatusFromProfile } from './profile-cloud-auth-status'

const { readSession, configuration } = vi.hoisted(() => ({
  readSession: vi.fn<() => OrcaCloudSessionReadResult>(),
  configuration: { configured: true }
}))

vi.mock('./profile-cloud-session-store', () => ({ readOrcaCloudSession: readSession }))
vi.mock('./profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => configuration,
  isOrcaCloudDevAuthEnabled: () => false
}))

function activeProfile(linked: boolean): ActiveOrcaProfileState {
  const profile: ActiveOrcaProfileState['profile'] = {
    id: 'profile-1',
    name: 'Personal',
    avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
    kind: linked ? 'cloud-linked' : 'local',
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    ...(linked
      ? {
          cloud: {
            cloudProfileId: 'cloud-1',
            userId: 'user-1',
            email: 'a@example.com',
            linkedAt: 0
          }
        }
      : {})
  }
  return {
    profile,
    index: { schemaVersion: 1, activeProfileId: profile.id, profiles: [profile] },
    dataFile: '',
    profileDirectory: ''
  }
}

const absentSessions: OrcaCloudSessionReadResult[] = [
  { status: 'missing', persistence: 'none' },
  { status: 'decrypt-failed', persistence: 'none', error: 'Cannot decrypt' },
  { status: 'unreadable', persistence: 'none', error: 'Permission denied' }
]

describe('unexpected sign-out auth evidence', () => {
  beforeEach(() => {
    readSession.mockReset()
    configuration.configured = true
  })

  it.each(absentSessions)('requires a preserved cloud link for $status credentials', (session) => {
    readSession.mockReturnValue(session)
    const linked = activeProfile(true)
    expect(getOrcaProfileAuthStatusFromProfile(linked, '')).toMatchObject({
      state: 'reconnect-required',
      cloud: linked.profile.cloud,
      persistence: 'none',
      credentialError: 'error' in session ? session.error : undefined
    })
    readSession.mockClear()
    const signedOut = getOrcaProfileAuthStatusFromProfile(activeProfile(false), '')
    expect(signedOut.state).toBe('local')
    expect(signedOut.cloud).toBeUndefined()
    expect(readSession).not.toHaveBeenCalled()
  })

  it.each(absentSessions)(
    'keeps unconfigured linked profiles out of reconnect for $status',
    (session) => {
      configuration.configured = false
      readSession.mockReturnValue(session)
      expect(getOrcaProfileAuthStatusFromProfile(activeProfile(true), '').state).toBe(
        'unconfigured'
      )
      expect(getOrcaProfileAuthStatusFromProfile(activeProfile(false), '').state).toBe(
        'unconfigured'
      )
    }
  )

  it('treats a live memory-only session as connected, then reconnects after its loss', () => {
    readSession.mockReturnValue({
      status: 'found',
      persistence: 'memory-only',
      session: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 60_000,
        capabilities: { flags: {}, refreshedAt: 0 }
      }
    })
    const linked = activeProfile(true)
    expect(getOrcaProfileAuthStatusFromProfile(linked, '')).toMatchObject({
      state: 'connected',
      persistence: 'memory-only'
    })
    readSession.mockReturnValue({ status: 'missing', persistence: 'none' })
    expect(getOrcaProfileAuthStatusFromProfile(linked, '').state).toBe('reconnect-required')
  })
})
