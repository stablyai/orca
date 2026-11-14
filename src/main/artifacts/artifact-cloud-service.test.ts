import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import type { OrcaProfileCloudSummary } from '../../shared/orca-profiles'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import {
  linkOrcaProfileToCloud,
  unlinkOrcaProfileFromCloud
} from '../orca-profiles/cloud-auth/profile-cloud-index'
import { signOutCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-owner'

import { ArtifactCloudService } from './artifact-cloud-service'

const createdPaths: string[] = []
const apiUrl = 'http://localhost:3000'
const cloudA: OrcaProfileCloudSummary = {
  cloudProfileId: 'cloud-a',
  userId: 'user-a',
  email: 'a@example.com',
  linkedAt: 1
}
const cloudB: OrcaProfileCloudSummary = {
  cloudProfileId: 'cloud-b',
  userId: 'user-b',
  email: 'b@example.com',
  linkedAt: 2
}

function createResponse(
  slug = 'artifact-a',
  expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
): Response {
  return new Response(
    JSON.stringify({
      artifact: {
        version: 1,
        slug,
        title: null,
        originalFileName: 'report.html',
        sourceContentType: 'text/html',
        renderedContentType: 'text/html',
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:00.000Z',
        expiresAt,
        byteSize: 12,
        deletedAt: null
      },
      shareUrl: `https://share.onorca.dev/a/${slug}`,
      editToken: 'edit-secret'
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

async function setup(sharingEnabled: { value: boolean } = { value: true }): Promise<{
  userDataPath: string
  profileId: string
  service: ArtifactCloudService
}> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-artifact-service-'))
  createdPaths.push(userDataPath)
  const active = ensureActiveOrcaProfile(userDataPath)
  linkOrcaProfileToCloud(active.profile.id, cloudA, userDataPath)
  return {
    userDataPath,
    profileId: active.profile.id,
    service: new ArtifactCloudService(userDataPath, () => sharingEnabled.value)
  }
}

const writeRequest = {
  sourceKey: '/repo/report.html',
  content: '<h1>Hi</h1>',
  contentType: 'text/html' as const,
  fileName: 'report.html',
  apiUrl,
  authToken: 'token-a'
}

beforeEach(() => {
  // Keep fixed response expirations independent of the runner's wall clock.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime('2026-08-07T00:00:00.000Z')
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('ArtifactCloudService record authorization', () => {
  it('refuses account B update and unshare after account A signs out', async () => {
    const { userDataPath, profileId, service } = await setup()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse()))
    await service.share(writeRequest)

    signOutCloudSession(profileId, userDataPath)
    unlinkOrcaProfileFromCloud(profileId, userDataPath)
    linkOrcaProfileToCloud(profileId, cloudB, userDataPath)

    await expect(service.update({ ...writeRequest, authToken: 'token-b' })).rejects.toThrow(
      /has not been shared/
    )
    await expect(
      service.unshare({ sourceKey: writeRequest.sourceKey, apiUrl, authToken: 'token-b' })
    ).rejects.toThrow(/has not been shared/)
  })

  it('does not persist an edit token when a POST completes after relink', async () => {
    const { userDataPath, profileId, service } = await setup()
    let resolvePost: ((response: Response) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolvePost = resolve
          })
      )
    )
    const pending = service.share(writeRequest)
    await vi.waitFor(() => expect(resolvePost).toBeTypeOf('function'))

    signOutCloudSession(profileId, userDataPath)
    unlinkOrcaProfileFromCloud(profileId, userDataPath)
    linkOrcaProfileToCloud(profileId, cloudB, userDataPath)
    resolvePost?.(createResponse())

    await expect(pending).rejects.toThrow(/account changed/)
    await expect(service.update({ ...writeRequest, authToken: 'token-b' })).rejects.toThrow(
      /has not been shared/
    )
  })

  it('allows a POST to finish across a same-account metadata refresh', async () => {
    const { userDataPath, profileId, service } = await setup()
    let resolvePost: ((response: Response) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolvePost = resolve
          })
      )
    )
    const pending = service.share(writeRequest)
    await vi.waitFor(() => expect(resolvePost).toBeTypeOf('function'))

    linkOrcaProfileToCloud(
      profileId,
      { ...cloudA, displayName: 'Updated name', linkedAt: 99 },
      userDataPath
    )
    resolvePost?.(createResponse())

    await expect(pending).resolves.toMatchObject({ status: 'ok' })
  })
})

describe('ArtifactCloudService publish capability gate', () => {
  it('keeps list and unshare working so links stay revocable after opting out', async () => {
    const sharing = { value: true }
    const { service } = await setup(sharing)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ artifacts: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await service.share(writeRequest)

    sharing.value = false
    await expect(service.list({ apiUrl, authToken: 'token-a' })).resolves.toMatchObject({
      status: 'ok'
    })
    await expect(
      service.getPublishedLink({ sourceKey: writeRequest.sourceKey, apiUrl, authToken: 'token-a' })
    ).resolves.toEqual({
      status: 'ok',
      value: { shareUrl: 'https://share.onorca.dev/a/artifact-a' }
    })
    await expect(
      service.unshare({ sourceKey: writeRequest.sourceKey, apiUrl, authToken: 'token-a' })
    ).resolves.toEqual({ status: 'ok', value: undefined })
  })
})
