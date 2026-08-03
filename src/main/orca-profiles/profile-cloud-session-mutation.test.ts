import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureCloudSessionMutation,
  isCloudSessionMutationCurrent,
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
})
