import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import type { OrcaProfileCloudSummary } from '../../shared/orca-profiles/orca-profiles'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { linkOrcaProfileToCloud } from '../orca-profiles/cloud-auth/profile-cloud-index'
import { saveOrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-store'
import { getArtifactShareRecord } from './artifact-share-record-store'
import { ArtifactCloudService } from './artifact-cloud-service'

const createdPaths: string[] = []
const apiUrl = 'http://localhost:3000'
const cloud: OrcaProfileCloudSummary = {
  cloudProfileId: 'cloud-a',
  userId: 'user-a',
  email: 'a@example.com',
  linkedAt: 1
}
const scope = {
  cloudUserId: cloud.userId,
  cloudProfileId: cloud.cloudProfileId,
  cloudOrganizationId: '',
  apiOrigin: apiUrl
}
const writeRequest = {
  sourceKey: '/repo/report.html',
  content: '<h1>Hi</h1>',
  contentType: 'text/html' as const,
  fileName: 'report.html',
  apiUrl
}

function artifactBody(): Record<string, unknown> {
  return {
    artifact: {
      version: 1,
      slug: 'artifact-a',
      title: null,
      originalFileName: 'report.html',
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '2026-08-07T12:00:00.000Z',
      updatedAt: '2026-08-07T12:00:00.000Z',
      expiresAt: '2026-09-07T00:00:00.000Z',
      byteSize: 12,
      deletedAt: null
    },
    shareUrl: 'https://share.onorca.dev/a/artifact-a'
  }
}

const created = (): Response => Response.json({ ...artifactBody(), editToken: 'edit-secret' })
const rejected = (): Response => Response.json({ code: 'unauthorized' }, { status: 401 })
const limited = (seconds: number): Response =>
  Response.json(
    {
      message: 'Too many artifact requests.',
      scope: 'account',
      limit: 20,
      windowSeconds: 3600,
      retryAfterSeconds: seconds
    },
    { status: 429, headers: { 'retry-after': String(seconds) } }
  )

type Sent = { method: string; token: string | null; key: string | null }

type CloudStub = {
  sent: Sent[]
  refreshes: number
}

/** Serves artifact responses in order and answers every refresh with the next session. */
function stubCloud(responses: (() => Response)[]): CloudStub {
  const stub: CloudStub = { sent: [], refreshes: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit) => {
      if (String(url).endsWith('/v1/desktop/auth/refresh')) {
        stub.refreshes++
        return Response.json({
          accessToken: `access-${stub.refreshes + 1}`,
          refreshToken: `refresh-${stub.refreshes + 1}`,
          expiresAt: Date.now() + 60 * 60 * 1000,
          cloud
        })
      }
      if (!String(url).includes('/v1/artifacts')) {
        throw new Error(`unexpected request to ${String(url)}`)
      }
      const headers = new Headers(init.headers)
      stub.sent.push({
        method: init.method ?? 'GET',
        token: headers.get('authorization'),
        key: headers.get('idempotency-key')
      })
      const next = responses.shift()
      if (!next) {
        throw new Error('unexpected extra artifact request')
      }
      return next()
    })
  )
  return stub
}

function saveSession(profileId: string, userDataPath: string, expiresInMs: number): void {
  saveOrcaCloudSession(profileId, userDataPath, {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + expiresInMs,
    capabilities: { flags: {}, refreshedAt: Date.now() }
  })
}

async function signIn(): Promise<{
  userDataPath: string
  profileId: string
  artifacts: ArtifactCloudService
}> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-artifact-auth-recovery-'))
  createdPaths.push(userDataPath)
  const profileId = ensureActiveOrcaProfile(userDataPath).profile.id
  linkOrcaProfileToCloud(profileId, cloud, userDataPath)
  saveSession(profileId, userDataPath, 60 * 60 * 1000)
  return { userDataPath, profileId, artifacts: new ArtifactCloudService(userDataPath, () => true) }
}

async function advanceRetryWait(): Promise<void> {
  // The pending intent is written to disk before the retry timer is scheduled.
  const deadline = performance.now() + 10_000
  while (vi.getTimerCount() === 0 && performance.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(5_000)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime('2026-08-07T12:00:00.000Z')
  vi.stubEnv('ORCA_CLOUD_API_URL', apiUrl)
  vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'orca-test')
  vi.stubEnv('ORCA_RELAY_URL', 'https://relay.example.test')
  vi.stubEnv('ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION', '1')
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

describe('a rate-limited artifact request that needs a session refresh', () => {
  it('surfaces the second 429 after the refresh instead of waiting and replaying again', async () => {
    const signin = await signIn()
    const cloudStub = stubCloud([() => limited(5), rejected, () => limited(5), created])

    const share = signin.artifacts.share(writeRequest).catch((caught: unknown) => caught)
    await advanceRetryWait()
    const outcome = await share

    expect(outcome).toMatchObject({
      statusCode: 429,
      code: 'artifact_rate_limited',
      data: { retryAfterSeconds: 5, scope: 'account', limit: 20, windowSeconds: 3600 }
    })
    expect(String(outcome)).toContain('Too many artifact requests.')
    expect(vi.getTimerCount()).toBe(0)
    expect(cloudStub.refreshes).toBe(1)
    expect(cloudStub.sent.map(({ method, token }) => [method, token])).toEqual([
      ['POST', 'Bearer access-1'],
      ['POST', 'Bearer access-1'],
      ['POST', 'Bearer access-2']
    ])
    expect(new Set(cloudStub.sent.map(({ key }) => key)).size).toBe(1)
    expect(cloudStub.sent[0]?.key).toBeTruthy()
  })

  it('still finishes with the refreshed session when it is no longer limited', async () => {
    const signin = await signIn()
    const cloudStub = stubCloud([() => limited(5), rejected, created])

    const share = signin.artifacts.share(writeRequest).catch((caught: unknown) => caught)
    await advanceRetryWait()
    const outcome = await share

    expect(outcome).toMatchObject({ status: 'ok', value: { shareUrl: artifactBody().shareUrl } })
    expect(cloudStub.refreshes).toBe(1)
    expect(cloudStub.sent.map(({ method, token }) => [method, token])).toEqual([
      ['POST', 'Bearer access-1'],
      ['POST', 'Bearer access-1'],
      ['POST', 'Bearer access-2']
    ])
    expect(new Set(cloudStub.sent.map(({ key }) => key)).size).toBe(1)
    expect(
      await getArtifactShareRecord(
        signin.profileId,
        signin.userDataPath,
        writeRequest.sourceKey,
        scope
      )
    ).toMatchObject({ slug: 'artifact-a', editToken: 'edit-secret' })
  })

  it('does not renew the wait when a reconciled create is re-run after its update got a 401', async () => {
    const signin = await signIn()
    // A lost create response leaves a pending create for the next publish to reconcile.
    stubCloud([
      () => {
        throw new TypeError('fetch failed')
      }
    ])
    await expect(signin.artifacts.publish(writeRequest)).rejects.toThrow('fetch failed')
    const changed = { ...writeRequest, content: '<h1>Changed</h1>' }
    const cloudStub = stubCloud([() => limited(5), created, rejected, () => limited(5)])

    const publish = signin.artifacts.publish(changed).catch((caught: unknown) => caught)
    await advanceRetryWait()
    const outcome = await publish

    expect(outcome).toMatchObject({ statusCode: 429, code: 'artifact_rate_limited' })
    expect(vi.getTimerCount()).toBe(0)
    expect(cloudStub.sent.map(({ method }) => method)).toEqual(['POST', 'POST', 'PUT', 'POST'])
  })
})
