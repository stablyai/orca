import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import type { OrcaProfileCloudSummary } from '../../shared/orca-profiles'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import {
  linkOrcaProfileToCloud,
  unlinkOrcaProfileFromCloud
} from '../orca-profiles/profile-cloud-index'
import {
  cloudSessionIdentity,
  recordSuccessfulCloudSessionLogin,
  tombstoneCloudSession
} from '../orca-profiles/profile-cloud-session-mutation'
import { saveOrcaCloudSession } from '../orca-profiles/profile-cloud-session-store'
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

function createResponse(slug = 'artifact-a', expiresAt = '2026-09-06T00:00:00.000Z'): Response {
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

async function setup(): Promise<{
  userDataPath: string
  profileId: string
  service: ArtifactCloudService
}> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-artifact-service-'))
  createdPaths.push(userDataPath)
  const active = ensureActiveOrcaProfile(userDataPath)
  linkOrcaProfileToCloud(active.profile.id, cloudA, userDataPath)
  recordSuccessfulCloudSessionLogin(cloudSessionIdentity(active.profile.id, cloudA), userDataPath)
  return {
    userDataPath,
    profileId: active.profile.id,
    service: new ArtifactCloudService(userDataPath)
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
  it('passes an opaque cursor and returns the complete list page', async () => {
    const { service } = await setup()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ artifacts: [], nextCursor: 'next-page' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      service.list({ apiUrl, authToken: 'token-a', cursor: 'opaque/+=' })
    ).resolves.toEqual({
      status: 'ok',
      value: { artifacts: [], nextCursor: 'next-page' }
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiUrl}/v1/artifacts?cursor=opaque%2F%2B%3D`,
      expect.any(Object)
    )
  })

  it('uses a distinct idempotency key for each logical share', async () => {
    const { service } = await setup()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse('artifact-a'))
      .mockResolvedValueOnce(createResponse('artifact-b'))
    vi.stubGlobal('fetch', fetchMock)

    await service.share(writeRequest)
    await service.share({ ...writeRequest, sourceKey: '/repo/other.html' })

    const firstKey = requestHeader(fetchMock, 0, 'idempotency-key')
    const secondKey = requestHeader(fetchMock, 1, 'idempotency-key')
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(secondKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(firstKey).not.toBe(secondKey)
  })

  it('keeps the idempotency key stable across an auth-refresh retry', async () => {
    const { service, profileId, userDataPath } = await setup()
    vi.stubEnv('ORCA_CLOUD_API_URL', 'http://localhost:4100')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
    saveOrcaCloudSession(profileId, userDataPath, {
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      expiresAt: Date.now() + 120_000,
      capabilities: { flags: {}, refreshedAt: Date.now() }
    })
    let artifactAttempts = 0
    const fetchMock = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input)
      if (url === `${apiUrl}/v1/artifacts`) {
        artifactAttempts += 1
        return Promise.resolve(
          artifactAttempts === 1
            ? new Response(JSON.stringify({ code: 'invalid_access_token' }), { status: 401 })
            : createResponse()
        )
      }
      if (url === 'http://localhost:4100/v1/desktop/auth/refresh') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              accessToken: 'access-new',
              refreshToken: 'refresh-new',
              expiresAt: Date.now() + 3_600_000,
              cloud: cloudA,
              capabilities: { flags: {}, refreshedAt: Date.now() }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.share({ ...writeRequest, authToken: undefined })).resolves.toMatchObject({
      status: 'ok'
    })

    expect(requestHeader(fetchMock, 0, 'authorization')).toBe('Bearer access-old')
    expect(requestHeader(fetchMock, 2, 'authorization')).toBe('Bearer access-new')
    expect(requestHeader(fetchMock, 0, 'idempotency-key')).toBe(
      requestHeader(fetchMock, 2, 'idempotency-key')
    )
  })

  it('refuses account B update and unshare after account A signs out', async () => {
    const { userDataPath, profileId, service } = await setup()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse()))
    await service.share(writeRequest)

    tombstoneCloudSession(cloudSessionIdentity(profileId, cloudA), userDataPath)
    unlinkOrcaProfileFromCloud(profileId, userDataPath)
    linkOrcaProfileToCloud(profileId, cloudB, userDataPath)
    recordSuccessfulCloudSessionLogin(cloudSessionIdentity(profileId, cloudB), userDataPath)

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

    tombstoneCloudSession(cloudSessionIdentity(profileId, cloudA), userDataPath)
    unlinkOrcaProfileFromCloud(profileId, userDataPath)
    linkOrcaProfileToCloud(profileId, cloudB, userDataPath)
    recordSuccessfulCloudSessionLogin(cloudSessionIdentity(profileId, cloudB), userDataPath)
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

  it('never scopes an explicit token to the profile linked in the UI', async () => {
    const { service } = await setup()
    const fetchMock = vi.fn().mockResolvedValue(createResponse())
    vi.stubGlobal('fetch', fetchMock)
    await service.share(writeRequest)

    await expect(service.update({ ...writeRequest, authToken: 'token-b' })).rejects.toThrow(
      /has not been shared/
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('cleans all matching source mappings after delete by slug', async () => {
    const { service } = await setup()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await service.share(writeRequest)
    await service.delete('artifact-a', { apiUrl, authToken: 'token-a' })

    await expect(service.update(writeRequest)).rejects.toThrow(/has not been shared/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps update and unshare working after an update extends expiration', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-08-07T00:00:00.000Z')
    const { service } = await setup()
    let resolveUpdate: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse('artifact-a', '2026-09-06T00:00:00.000Z'))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveUpdate = resolve
          })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await service.share(writeRequest)
    vi.setSystemTime('2026-09-05T00:00:00.000Z')
    const update = service.update(writeRequest)
    await vi.waitFor(() => expect(resolveUpdate).toBeTypeOf('function'))
    vi.setSystemTime('2026-09-07T00:00:00.000Z')
    resolveUpdate?.(createResponse('artifact-a', '2026-10-06T00:00:00.000Z'))
    await update
    await expect(
      service.unshare({ sourceKey: writeRequest.sourceKey, apiUrl, authToken: 'token-a' })
    ).resolves.toEqual({ status: 'ok', value: undefined })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

function requestHeader(
  fetchMock: ReturnType<typeof vi.fn>,
  index: number,
  name: string
): string | null {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
  return new Headers(init?.headers).get(name)
}
