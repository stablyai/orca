import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureCloudSessionMutation,
  isCloudSessionMutationCurrent,
  MAX_CLOUD_SESSION_IDENTITY_KEY_BYTES,
  MAX_CLOUD_SESSION_MUTATION_STATE_FILE_BYTES,
  MAX_CLOUD_SESSION_TOMBSTONES,
  recordCloudSessionIdentityMutation,
  recordSuccessfulCloudSessionLogin,
  tombstoneCloudSession,
  type CloudSessionIdentity
} from './profile-cloud-session-mutation'

describe('cloud session mutation fence', () => {
  let userDataPath: string
  const identity: CloudSessionIdentity = {
    localProfileId: 'local-1',
    cloudUserId: 'user-1',
    cloudProfileId: 'profile-1',
    organizationId: 'org-1'
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-session-mutation-'))
  })

  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  it('invalidates a captured refresh before destructive sign-out', () => {
    const snapshot = captureCloudSessionMutation(identity, userDataPath)
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, snapshot)).toBe(
      true
    )
    tombstoneCloudSession(identity, userDataPath)
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, snapshot)).toBe(
      false
    )
  })

  it('clears only the matching tombstone after explicit successful login', () => {
    tombstoneCloudSession(identity, userDataPath)
    const login = recordSuccessfulCloudSessionLogin(identity, userDataPath)
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, login)).toBe(true)
  })

  it('invalidates old work when the expected org changes without tombstoning either identity', () => {
    const old = captureCloudSessionMutation(identity, userDataPath)
    const next = recordCloudSessionIdentityMutation(
      { ...identity, organizationId: 'org-2' },
      userDataPath
    )
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, old)).toBe(false)
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, next)).toBe(true)
  })

  it('persists the fence across module-independent reads', () => {
    const snapshot = recordSuccessfulCloudSessionLogin(identity, userDataPath)
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, snapshot)).toBe(
      true
    )
  })

  it('rejects an oversized sparse mutation fence before parsing it', () => {
    const profileDirectory = join(userDataPath, 'profiles', identity.localProfileId)
    mkdirSync(profileDirectory, { recursive: true })
    const path = join(profileDirectory, 'account-session-mutation.json')
    writeFileSync(path, '{"version":1}')
    truncateSync(path, MAX_CLOUD_SESSION_MUTATION_STATE_FILE_BYTES + 1)

    expect(() => captureCloudSessionMutation(identity, userDataPath)).toThrow(
      'invalid_cloud_session_mutation_state'
    )
  })

  it('bounds tombstones while the advancing epoch keeps old snapshots invalid', () => {
    const firstIdentity = { ...identity, cloudUserId: 'user-0' }
    const firstSnapshot = captureCloudSessionMutation(firstIdentity, userDataPath)

    for (let index = 0; index <= MAX_CLOUD_SESSION_TOMBSTONES; index += 1) {
      tombstoneCloudSession({ ...identity, cloudUserId: `user-${index}` }, userDataPath)
    }

    const path = join(
      userDataPath,
      'profiles',
      identity.localProfileId,
      'account-session-mutation.json'
    )
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      tombstonedIdentityKeys: string[]
    }
    expect(state.tombstonedIdentityKeys).toHaveLength(MAX_CLOUD_SESSION_TOMBSTONES)
    expect(
      isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, firstSnapshot)
    ).toBe(false)
  })

  it('rejects an oversized identity before changing the last readable fence', () => {
    captureCloudSessionMutation(identity, userDataPath)
    const path = join(
      userDataPath,
      'profiles',
      identity.localProfileId,
      'account-session-mutation.json'
    )
    const before = readFileSync(path, 'utf8')

    expect(() =>
      recordCloudSessionIdentityMutation(
        { ...identity, cloudUserId: 'x'.repeat(MAX_CLOUD_SESSION_IDENTITY_KEY_BYTES) },
        userDataPath
      )
    ).toThrow('cloud_session_identity_too_large')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})
