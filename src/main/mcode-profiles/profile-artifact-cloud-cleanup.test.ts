import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MCodeProfileCloudSummary } from '../../shared/mcode-profiles'
import type * as ArtifactCreateIntentStore from '../artifacts/artifact-create-intent-store'
import type * as ProfileArtifactCloudCleanup from './profile-artifact-cloud-cleanup'
import type * as ProfileIndexStore from './profile-index-store'

vi.mock('../artifacts/artifact-create-intent-store', async () => {
  const actual = await vi.importActual<typeof ArtifactCreateIntentStore>(
    '../artifacts/artifact-create-intent-store'
  )
  return { ...actual, clearArtifactCreateIntents: vi.fn(actual.clearArtifactCreateIntents) }
})

vi.mock('./profile-index-store', async () => {
  const actual = await vi.importActual<typeof ProfileIndexStore>('./profile-index-store')
  return { ...actual, writeProfileIndex: vi.fn(actual.writeProfileIndex) }
})

vi.mock('./profile-artifact-cloud-cleanup', async () => {
  const actual = await vi.importActual<typeof ProfileArtifactCloudCleanup>(
    './profile-artifact-cloud-cleanup'
  )
  return {
    ...actual,
    commitArtifactCloudCleanup: vi.fn(actual.commitArtifactCloudCleanup)
  }
})

import {
  clearArtifactCreateIntents,
  getArtifactCreateIntent,
  getOrCreateArtifactCreateIntent
} from '../artifacts/artifact-create-intent-store'
import type { ArtifactShareScope } from '../artifacts/artifact-share-record-store'
import {
  artifactCloudCleanupNeedsCommit,
  commitArtifactCloudCleanup,
  prepareArtifactCloudCleanup,
  prepareArtifactCloudUse
} from './profile-artifact-cloud-cleanup'
import { linkMCodeProfileToCloud, unlinkMCodeProfileFromCloud } from './profile-cloud-index'
import {
  getMCodeProfileIndexPath,
  getMCodeProfileDirectory,
  loadOrCreateProfileIndex,
  readProfileIndex,
  writeProfileIndex
} from './profile-index-store'

const createdPaths: string[] = []
const profileId = 'local-default'

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('profile artifact cloud cleanup', () => {
  it('preserves recovery state when the profile write fails', async () => {
    const userDataPath = await createLinkedProfile(cloud('org-a'))
    const scope = shareScope('org-a')
    createIntent(userDataPath, scope)
    vi.mocked(writeProfileIndex).mockImplementationOnce(() => {
      throw new Error('profile write failed')
    })

    expect(() => linkMCodeProfileToCloud(profileId, cloud('org-b'), userDataPath)).toThrow(
      'profile write failed'
    )
    expect(getArtifactCreateIntent(profileId, userDataPath, '/report.md', scope)).not.toBeNull()

    linkMCodeProfileToCloud(profileId, cloud('org-b'), userDataPath)
    expect(getArtifactCreateIntent(profileId, userDataPath, '/report.md', scope)).toBeNull()
  })

  it('retries cleanup after the profile transition commits', async () => {
    const userDataPath = await createLinkedProfile(cloud('org-a'))
    const scope = shareScope('org-a')
    createIntent(userDataPath, scope)
    vi.mocked(clearArtifactCreateIntents).mockImplementationOnce(() => {
      throw new Error('cleanup failed')
    })

    expect(() => linkMCodeProfileToCloud(profileId, cloud('org-b'), userDataPath)).toThrow(
      'cleanup failed'
    )
    expect(currentCloud(userDataPath)?.activeOrgId).toBe('org-b')
    expect(getArtifactCreateIntent(profileId, userDataPath, '/report.md', scope)).not.toBeNull()

    linkMCodeProfileToCloud(profileId, cloud('org-b'), userDataPath)
    expect(getArtifactCreateIntent(profileId, userDataPath, '/report.md', scope)).toBeNull()
  })

  it('reconciles an interrupted transition before linking again', async () => {
    const userDataPath = await createLinkedProfile(cloud('org-a'))
    const scope = shareScope('org-a')
    createIntent(userDataPath, scope)
    interruptNextCleanupCommit()

    expect(() => linkMCodeProfileToCloud(profileId, cloud('org-b'), userDataPath)).toThrow(
      'cleanup commit interrupted'
    )
    expect(currentCloud(userDataPath)?.activeOrgId).toBe('org-b')
    vi.mocked(writeProfileIndex).mockClear()
    vi.mocked(clearArtifactCreateIntents).mockImplementationOnce(() => {
      throw new Error('cleanup failed')
    })

    expect(() => linkMCodeProfileToCloud(profileId, cloud('org-c'), userDataPath)).toThrow(
      'cleanup failed'
    )
    expect(writeProfileIndex).not.toHaveBeenCalled()
    expect(currentCloud(userDataPath)?.activeOrgId).toBe('org-b')
    expect(getArtifactCreateIntent(profileId, userDataPath, '/report.md', scope)).not.toBeNull()

    linkMCodeProfileToCloud(profileId, cloud('org-c'), userDataPath)
    expect(currentCloud(userDataPath)?.activeOrgId).toBe('org-c')
    expect(getArtifactCreateIntent(profileId, userDataPath, '/report.md', scope)).toBeNull()
  })

  it('reconciles an interrupted transition before unlinking', async () => {
    const userDataPath = await createLinkedProfile(cloud('org-a'))
    const scope = shareScope('org-a')
    createIntent(userDataPath, scope)
    interruptNextCleanupCommit()

    expect(() => linkMCodeProfileToCloud(profileId, cloud('org-b'), userDataPath)).toThrow(
      'cleanup commit interrupted'
    )
    expect(currentCloud(userDataPath)?.activeOrgId).toBe('org-b')
    vi.mocked(writeProfileIndex).mockClear()
    vi.mocked(clearArtifactCreateIntents).mockImplementationOnce(() => {
      throw new Error('cleanup failed')
    })

    expect(() => unlinkMCodeProfileFromCloud(profileId, userDataPath)).toThrow('cleanup failed')
    expect(writeProfileIndex).not.toHaveBeenCalled()
    expect(currentCloud(userDataPath)?.activeOrgId).toBe('org-b')
    expect(getArtifactCreateIntent(profileId, userDataPath, '/report.md', scope)).not.toBeNull()

    unlinkMCodeProfileFromCloud(profileId, userDataPath)
    expect(currentCloud(userDataPath)).toBeUndefined()
    expect(getArtifactCreateIntent(profileId, userDataPath, '/report.md', scope)).toBeNull()
  })

  it('preserves an orphaned local marker for an unknown profile', async () => {
    const userDataPath = await createLinkedProfile(cloud('org-a'))
    const orphanProfileId = 'missing-profile'
    const scope = shareScope('org-a')
    mkdirSync(getMCodeProfileDirectory(orphanProfileId, userDataPath), { recursive: true })
    createIntent(userDataPath, scope, orphanProfileId)
    prepareArtifactCloudCleanup(orphanProfileId, userDataPath, undefined)

    const transitions = [
      () => linkMCodeProfileToCloud(orphanProfileId, cloud('org-b'), userDataPath),
      () => unlinkMCodeProfileFromCloud(orphanProfileId, userDataPath)
    ]
    for (const transition of transitions) {
      expect(transition).toThrow('unknown_mcode_profile')
      expect(artifactCloudCleanupNeedsCommit(orphanProfileId, userDataPath, undefined)).toBe(true)
      expect(
        getArtifactCreateIntent(orphanProfileId, userDataPath, '/report.md', scope)
      ).not.toBeNull()
    }
  })

  it('cleans old recovery state when the active organization changes', async () => {
    const userDataPath = await createLinkedProfile(cloud('org-a'))
    const scope = shareScope('org-a')
    createIntent(userDataPath, scope)

    linkMCodeProfileToCloud(profileId, cloud('org-b'), userDataPath)

    expect(getArtifactCreateIntent(profileId, userDataPath, '/report.md', scope)).toBeNull()
  })

  it('blocks artifact use until a visible transition is durably committed', async () => {
    const cloudSummary = cloud('org-a')
    const userDataPath = await createLinkedProfile(cloudSummary)
    prepareArtifactCloudCleanup(profileId, userDataPath, cloudSummary)

    expect(() =>
      prepareArtifactCloudUse({ id: profileId, cloud: cloudSummary }, userDataPath)
    ).toThrow(/transition must be retried/)
  })
})

function cloud(activeOrgId: string): MCodeProfileCloudSummary {
  return {
    cloudProfileId: 'cloud-profile-a',
    userId: 'user-a',
    email: 'user@example.com',
    activeOrgId,
    linkedAt: 1
  }
}

function shareScope(cloudOrganizationId: string): ArtifactShareScope {
  return {
    cloudUserId: 'user-a',
    cloudProfileId: 'cloud-profile-a',
    cloudOrganizationId,
    apiOrigin: 'https://share.mcode.dev'
  }
}

async function createLinkedProfile(cloudSummary: MCodeProfileCloudSummary): Promise<string> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'mcode-profile-artifact-cleanup-'))
  createdPaths.push(userDataPath)
  loadOrCreateProfileIndex(userDataPath)
  linkMCodeProfileToCloud(profileId, cloudSummary, userDataPath)
  vi.clearAllMocks()
  return userDataPath
}

function createIntent(
  userDataPath: string,
  scope: ArtifactShareScope,
  targetProfileId = profileId
): void {
  getOrCreateArtifactCreateIntent(targetProfileId, userDataPath, '/report.md', scope, 'key-a', {
    content: '# report',
    contentType: 'text/markdown',
    fileName: 'report.md'
  })
}

function currentCloud(userDataPath: string): MCodeProfileCloudSummary | undefined {
  return readProfileIndex(getMCodeProfileIndexPath(userDataPath))?.profiles.find(
    (profile) => profile.id === profileId
  )?.cloud
}

function interruptNextCleanupCommit(): void {
  vi.mocked(commitArtifactCloudCleanup).mockImplementationOnce(() => {
    throw new Error('cleanup commit interrupted')
  })
}
