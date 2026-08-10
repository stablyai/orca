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
import {
  ARTIFACT_SHARING_DISABLED_CODE,
  ARTIFACT_SHARING_DISABLED_MESSAGE,
  isArtifactSharingEnabled
} from '../../shared/artifact-sharing-gate'
import { getDefaultSettings } from '../../shared/constants'
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

async function setup(sharingEnabled: { value: boolean } = { value: true }): Promise<{
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

  it('creates once and updates on repeated publish', async () => {
    const { service } = await setup()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(createResponse())
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.publish(writeRequest)).resolves.toMatchObject({
      status: 'ok',
      value: { change: 'created', item: { shareUrl: 'https://share.onorca.dev/a/artifact-a' } }
    })
    await expect(service.publish(writeRequest)).resolves.toMatchObject({
      status: 'ok',
      value: { change: 'updated', item: { shareUrl: 'https://share.onorca.dev/a/artifact-a' } }
    })

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${apiUrl}/v1/artifacts/artifact-a`)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' })
  })

  it('resolves a persisted public link only for its source and cloud scope', async () => {
    const { service } = await setup()
    const fetchMock = vi.fn().mockResolvedValueOnce(createResponse())
    vi.stubGlobal('fetch', fetchMock)

    await service.publish(writeRequest)

    await expect(
      service.getPublishedLink({ sourceKey: writeRequest.sourceKey, apiUrl, authToken: 'token-a' })
    ).resolves.toEqual({
      status: 'ok',
      value: { shareUrl: 'https://share.onorca.dev/a/artifact-a' }
    })
    await expect(
      service.getPublishedLink({ sourceKey: '/repo/other.html', apiUrl, authToken: 'token-a' })
    ).resolves.toEqual({ status: 'ok', value: null })
    await expect(
      service.getPublishedLink({ sourceKey: writeRequest.sourceKey, apiUrl, authToken: 'token-b' })
    ).resolves.toEqual({ status: 'ok', value: null })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('serializes concurrent publishes for the same source', async () => {
    const { service } = await setup()
    let resolveCreate: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveCreate = resolve
          })
      )
      .mockResolvedValueOnce(createResponse())
    vi.stubGlobal('fetch', fetchMock)

    const first = service.publish(writeRequest)
    const second = service.publish(writeRequest)
    await vi.waitFor(() => expect(resolveCreate).toBeTypeOf('function'))
    expect(fetchMock).toHaveBeenCalledOnce()
    resolveCreate?.(createResponse())

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'ok', value: { change: 'created' } },
      { status: 'ok', value: { change: 'updated' } }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' })
  })

  it('serializes manual publish with CLI share for the same source', async () => {
    const { service } = await setup()
    let resolvePublish: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolvePublish = resolve
          })
      )
      .mockResolvedValueOnce(createResponse('artifact-b'))
    vi.stubGlobal('fetch', fetchMock)

    const publish = service.publish(writeRequest)
    const share = service.share(writeRequest)
    await vi.waitFor(() => expect(resolvePublish).toBeTypeOf('function'))
    expect(fetchMock).toHaveBeenCalledOnce()
    resolvePublish?.(createResponse('artifact-a'))

    await expect(Promise.all([publish, share])).resolves.toMatchObject([
      { status: 'ok', value: { change: 'created' } },
      { status: 'ok', value: { shareUrl: 'https://share.onorca.dev/a/artifact-b' } }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('serializes account deletion with a mapped source update', async () => {
    const { service } = await setup()
    let resolveUpdate: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse())
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveUpdate = resolve
          })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await service.share(writeRequest)

    const update = service.update(writeRequest)
    await vi.waitFor(() => expect(resolveUpdate).toBeTypeOf('function'))
    const deletion = service.delete('artifact-a', { apiUrl, authToken: 'token-a' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    resolveUpdate?.(createResponse())

    await expect(Promise.all([update, deletion])).resolves.toMatchObject([
      { status: 'ok' },
      { status: 'ok' }
    ])
    await expect(
      service.getPublishedLink({ sourceKey: writeRequest.sourceKey, apiUrl, authToken: 'token-a' })
    ).resolves.toEqual({ status: 'ok', value: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('recreates an artifact when its stored public link was deleted elsewhere', async () => {
    const { service } = await setup()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse('artifact-a'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'not_found' }), { status: 404 }))
      .mockResolvedValueOnce(createResponse('artifact-b'))
      .mockResolvedValueOnce(createResponse('artifact-b'))
    vi.stubGlobal('fetch', fetchMock)

    await service.publish(writeRequest)
    await expect(service.publish(writeRequest)).resolves.toMatchObject({
      status: 'ok',
      value: { change: 'created', item: { shareUrl: 'https://share.onorca.dev/a/artifact-b' } }
    })
    await expect(service.publish(writeRequest)).resolves.toMatchObject({
      status: 'ok',
      value: { change: 'updated', item: { shareUrl: 'https://share.onorca.dev/a/artifact-b' } }
    })

    expect(fetchMock.mock.calls.map(([, options]) => options?.method)).toEqual([
      'POST',
      'PUT',
      'POST',
      'PUT'
    ])
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

describe('ArtifactCloudService publish capability gate', () => {
  it('ships with the capability off so a fresh profile denies agent publishing', () => {
    expect(isArtifactSharingEnabled(getDefaultSettings('/tmp'))).toBe(false)
  })

  it.each([
    ['share', (service: ArtifactCloudService) => service.share(writeRequest)],
    ['publish', (service: ArtifactCloudService) => service.publish(writeRequest)],
    ['update', (service: ArtifactCloudService) => service.update(writeRequest)]
  ])('rejects %s without reaching the network when the capability is off', async (_name, call) => {
    const { service } = await setup({ value: false })
    const fetchMock = vi.fn().mockResolvedValue(createResponse())
    vi.stubGlobal('fetch', fetchMock)

    await expect(call(service)).rejects.toMatchObject({
      code: ARTIFACT_SHARING_DISABLED_CODE,
      data: { nextSteps: expect.arrayContaining([expect.stringContaining('Settings')]) }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('denies the dev auth-token override too, so the gate is not bypassable by env', async () => {
    const { service } = await setup({ value: false })
    const fetchMock = vi.fn().mockResolvedValue(createResponse())
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.share({ ...writeRequest, authToken: 'token-a' })).rejects.toThrow(
      ARTIFACT_SHARING_DISABLED_MESSAGE
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('persists no share record for a denied share, so a later update stays denied', async () => {
    const sharing = { value: false }
    const { service } = await setup(sharing)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse()))

    await expect(service.share(writeRequest)).rejects.toThrow(ARTIFACT_SHARING_DISABLED_MESSAGE)
    sharing.value = true
    await expect(service.update(writeRequest)).rejects.toThrow(/has not been shared/)
  })

  it('keeps list, unshare, and delete working so links stay revocable after opting out', async () => {
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

  it('re-reads the capability per call so revoking it stops the next share', async () => {
    const sharing = { value: true }
    const { service } = await setup(sharing)
    const fetchMock = vi.fn().mockResolvedValue(createResponse())
    vi.stubGlobal('fetch', fetchMock)

    await service.share(writeRequest)
    sharing.value = false
    await expect(service.share({ ...writeRequest, sourceKey: '/repo/other.html' })).rejects.toThrow(
      ARTIFACT_SHARING_DISABLED_MESSAGE
    )
    expect(fetchMock).toHaveBeenCalledOnce()
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
