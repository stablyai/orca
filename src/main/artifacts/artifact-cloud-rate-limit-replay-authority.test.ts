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
import {
  linkOrcaProfileToCloud,
  unlinkOrcaProfileFromCloud
} from '../orca-profiles/cloud-auth/profile-cloud-index'
import { signOutCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-owner'
import { saveOrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-store'
import { signOutCurrentOrcaProfile } from '../orca-profiles/cloud-auth/profile-cloud-service'
import { getArtifactShareRecord } from './artifact-share-record-store'
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
const writeRequest = {
  sourceKey: '/repo/report.html',
  content: '<h1>Hi</h1>',
  contentType: 'text/html' as const,
  fileName: 'report.html',
  apiUrl
}

type Signin = { userDataPath: string; profileId: string; artifacts: ArtifactCloudService }

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
const updated = (): Response => Response.json(artifactBody())
const deleted = (): Response => new Response(null, { status: 204 })
const limited = (): Response =>
  Response.json(
    { message: 'Too many artifact requests.', retryAfterSeconds: 30 },
    { status: 429, headers: { 'retry-after': '30' } }
  )

/** Serves `responses` in order and records each request's method. */
function stubFetch(...responses: Response[]): { methods: string[] } {
  const methods: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? 'GET')
      const next = responses.shift()
      if (!next) {
        throw new Error('unexpected extra artifact request')
      }
      return next
    })
  )
  return { methods }
}

async function signIn(): Promise<Signin> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-artifact-replay-authority-'))
  createdPaths.push(userDataPath)
  const profileId = ensureActiveOrcaProfile(userDataPath).profile.id
  linkOrcaProfileToCloud(profileId, cloudA, userDataPath)
  saveOrcaCloudSession(profileId, userDataPath, {
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
    expiresAt: Date.now() + 60 * 60 * 1000,
    capabilities: { flags: {}, refreshedAt: Date.now() }
  })
  return { userDataPath, profileId, artifacts: new ArtifactCloudService(userDataPath, () => true) }
}

function signOutInApp({ profileId, userDataPath }: Signin): void {
  signOutCloudSession(profileId, userDataPath)
  unlinkOrcaProfileFromCloud(profileId, userDataPath)
}

function switchAccount(signin: Signin): void {
  signOutInApp(signin)
  linkOrcaProfileToCloud(signin.profileId, cloudB, signin.userDataPath)
}

// A server-revoked session signs out without unlinking the profile.
function revokeSession({ profileId, userDataPath }: Signin): void {
  signOutCloudSession(profileId, userDataPath)
}

// The wait is scheduled after the 429 body is read; act only once it exists.
async function untilRetryScheduled(): Promise<void> {
  // Real disk I/O runs first, so bound this by wall time; vi.waitUntil would advance the fake clock.
  const deadline = performance.now() + 10_000
  while (vi.getTimerCount() === 0 && performance.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  expect(vi.getTimerCount()).toBe(1)
}

/** Starts `run`, changes the account during the 429 wait, then lets the wait end. */
async function changeAccountDuringWait<T>(
  run: () => Promise<T>,
  change: () => void
): Promise<unknown> {
  const outcome = run().catch((caught: unknown) => caught)
  await untilRetryScheduled()
  change()
  await vi.advanceTimersByTimeAsync(30_000)
  return outcome
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

describe('a rate-limited artifact request whose account changes during the wait', () => {
  it('does not replay while the real sign-out is still waiting on remote logout', async () => {
    const signin = await signIn()
    const artifactMethods: string[] = []
    const artifactResponses = [limited(), created()]
    let finishLogout: (response: Response) => void = () => {}
    let logoutRequests = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit) => {
        if (String(url).includes('/v1/artifacts')) {
          artifactMethods.push(init.method ?? 'GET')
          const next = artifactResponses.shift()
          if (!next) {
            throw new Error('unexpected extra artifact request')
          }
          return next
        }
        logoutRequests++
        return new Promise<Response>((resolve) => {
          finishLogout = resolve
        })
      })
    )

    const outcome = signin.artifacts.share(writeRequest).catch((caught: unknown) => caught)
    await untilRetryScheduled()
    const signingOut = signOutCurrentOrcaProfile(signin.userDataPath)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(String(await outcome)).toContain('Signed out of Orca while waiting to retry')
    expect(artifactMethods).toEqual(['POST'])
    expect(logoutRequests).toBe(1)
    finishLogout(Response.json({}))
    await expect(signingOut).resolves.toMatchObject({ status: 'signed-out' })
    expect(artifactMethods).toEqual(['POST'])
    expect(
      await getArtifactShareRecord(signin.profileId, signin.userDataPath, writeRequest.sourceKey, {
        cloudUserId: cloudA.userId,
        cloudProfileId: cloudA.cloudProfileId,
        cloudOrganizationId: '',
        apiOrigin: apiUrl
      })
    ).toBeNull()
  })

  it('does not create the artifact after the user signs out', async () => {
    const signin = await signIn()
    const fetches = stubFetch(limited(), created())

    const outcome = await changeAccountDuringWait(
      () => signin.artifacts.share(writeRequest),
      () => signOutInApp(signin)
    )

    expect(outcome).toBeInstanceOf(Error)
    expect(String(outcome)).toContain('account changed')
    expect(fetches.methods).toEqual(['POST'])
  })

  it('does not apply the update under the previous account after a switch', async () => {
    const signin = await signIn()
    const fetches = stubFetch(created(), limited(), updated())
    await signin.artifacts.share(writeRequest)

    const outcome = await changeAccountDuringWait(
      () => signin.artifacts.update(writeRequest),
      () => switchAccount(signin)
    )

    expect(String(outcome)).toContain('account changed')
    expect(fetches.methods).toEqual(['POST', 'PUT'])
  })

  it('does not delete with a session the server revoked during the wait', async () => {
    const signin = await signIn()
    const fetches = stubFetch(created(), limited(), deleted())
    await signin.artifacts.share(writeRequest)

    const outcome = await changeAccountDuringWait(
      () => signin.artifacts.unshare({ sourceKey: writeRequest.sourceKey, apiUrl }),
      () => revokeSession(signin)
    )

    expect(String(outcome)).toContain('Signed out of Orca while waiting to retry')
    expect(fetches.methods).toEqual(['POST', 'DELETE'])
  })

  it('does not delete by id under the previous account after a switch', async () => {
    const signin = await signIn()
    const fetches = stubFetch(limited(), deleted())

    const outcome = await changeAccountDuringWait(
      () => signin.artifacts.delete('artifact-a', { apiUrl }),
      () => switchAccount(signin)
    )

    expect(String(outcome)).toContain('account changed')
    expect(fetches.methods).toEqual(['DELETE'])
  })

  it('still replays once when the same account stays signed in', async () => {
    const signin = await signIn()
    const fetches = stubFetch(created(), limited(), updated())
    await signin.artifacts.share(writeRequest)

    const outcome = await changeAccountDuringWait(
      () => signin.artifacts.update(writeRequest),
      () => {}
    )

    expect(outcome).toMatchObject({ status: 'ok' })
    expect(fetches.methods).toEqual(['POST', 'PUT', 'PUT'])
  })
})
