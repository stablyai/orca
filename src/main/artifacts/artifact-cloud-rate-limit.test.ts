import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { linkOrcaProfileToCloud } from '../orca-profiles/cloud-auth/profile-cloud-index'
import { mapRuntimeError } from '../runtime/rpc/responses/rpc-response'
import { ArtifactCloudService } from './artifact-cloud-service'

const createdPaths: string[] = []
const apiUrl = 'http://localhost:3000'
const now = new Date('2026-08-07T12:00:00.000Z')
const resetAt = '2026-08-07T12:45:00.000Z'

const writeRequest = {
  sourceKey: '/repo/report.html',
  content: '<h1>Hi</h1>',
  contentType: 'text/html' as const,
  fileName: 'report.html',
  apiUrl,
  authToken: 'token-a'
}

function createdResponse(): Response {
  return Response.json({
    artifact: {
      version: 1,
      slug: 'artifact-a',
      title: null,
      originalFileName: 'report.html',
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: '2026-09-07T00:00:00.000Z',
      byteSize: 12,
      deletedAt: null
    },
    shareUrl: 'https://share.onorca.dev/a/artifact-a',
    editToken: 'edit-secret'
  })
}

function rateLimited(retryAfter: string | null, body?: Record<string, unknown>): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status: 429,
    headers: {
      ...(retryAfter === null ? {} : { 'retry-after': retryAfter }),
      ...(body ? { 'content-type': 'application/json' } : {})
    }
  })
}

function limitBody(retryAfterSeconds: number): Record<string, unknown> {
  return {
    message: 'You have shared 20 artifacts this hour.',
    scope: 'account',
    limit: 20,
    windowSeconds: 3600,
    retryAfterSeconds,
    resetAt
  }
}

/** Serves `responses` in order and records each request's idempotency key. */
function stubFetch(...responses: Response[]): { keys: (string | null)[] } {
  const keys: (string | null)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get('idempotency-key'))
      const next = responses.shift()
      if (!next) {
        throw new Error('unexpected extra artifact request')
      }
      return next
    })
  )
  return { keys }
}

async function service(): Promise<ArtifactCloudService> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-artifact-rate-limit-'))
  createdPaths.push(userDataPath)
  const active = ensureActiveOrcaProfile(userDataPath)
  linkOrcaProfileToCloud(
    active.profile.id,
    { cloudProfileId: 'cloud-a', userId: 'user-a', email: 'a@example.com', linkedAt: 1 },
    userDataPath
  )
  return new ArtifactCloudService(userDataPath, () => true)
}

// The wait is scheduled after the 429 body is read; advance only once it exists.
async function untilRetryScheduled(): Promise<void> {
  // Real disk I/O runs first, so bound this by wall time; vi.waitUntil would advance the fake clock.
  const deadline = performance.now() + 10_000
  while (vi.getTimerCount() === 0 && performance.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  expect(vi.getTimerCount()).toBe(1)
}

async function shareFailure(artifacts: ArtifactCloudService): Promise<Error> {
  const error: unknown = await artifacts.share(writeRequest).catch((caught: unknown) => caught)
  if (!(error instanceof Error)) {
    throw new Error('expected the share to fail')
  }
  return error
}

function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(now)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('artifact share under a rate limit', () => {
  it('fails fast with the server message and local reset time when the wait is long', async () => {
    const artifacts = await service()
    const fetches = stubFetch(rateLimited('2700', limitBody(2700)))

    const error = await shareFailure(artifacts)

    expect(fetches.keys).toHaveLength(1)
    expect(error).toMatchObject({
      code: 'artifact_rate_limited',
      data: { scope: 'account', limit: 20, windowSeconds: 3600, retryAfterSeconds: 2700, resetAt }
    })
    const message = error.message
    expect(message).toContain('You have shared 20 artifacts this hour.')
    expect(message).toContain(`Try again after`)
    expect(message).toContain(localTime(resetAt))
    expect(message).not.toContain(resetAt)
    expect(mapRuntimeError('request-1', { runtimeId: 'runtime-1' }, error).error).toMatchObject({
      code: 'artifact_rate_limited',
      message,
      data: { resetAt, retryAfterSeconds: 2700 }
    })
  })

  it('waits out a short Retry-After and replays once with the same Idempotency-Key', async () => {
    const artifacts = await service()
    const fetches = stubFetch(rateLimited('30', limitBody(30)), createdResponse())

    const shared = artifacts.share(writeRequest)
    await untilRetryScheduled()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetches.keys).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(shared).resolves.toMatchObject({
      status: 'ok',
      value: { shareUrl: 'https://share.onorca.dev/a/artifact-a' }
    })
    expect(fetches.keys).toHaveLength(2)
    expect(fetches.keys[0]).toBeTruthy()
    expect(fetches.keys[1]).toBe(fetches.keys[0])
  })

  it('gives up after one replay when the server is still limiting', async () => {
    const artifacts = await service()
    const fetches = stubFetch(rateLimited('10', limitBody(10)), rateLimited('10', limitBody(10)))

    const shared = artifacts.share(writeRequest).catch((caught: unknown) => caught)
    await untilRetryScheduled()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(await shared).toMatchObject({ code: 'artifact_rate_limited' })
    expect(vi.getTimerCount()).toBe(0)
    expect(fetches.keys).toHaveLength(2)
  })

  it('reuses the pending Idempotency-Key when the user shares again after a rate limit', async () => {
    const artifacts = await service()
    const fetches = stubFetch(rateLimited('600', limitBody(600)), createdResponse())

    await expect(artifacts.share(writeRequest)).rejects.toMatchObject({ statusCode: 429 })
    await expect(artifacts.share(writeRequest)).resolves.toBeTruthy()

    expect(fetches.keys).toHaveLength(2)
    expect(fetches.keys[1]).toBe(fetches.keys[0])
  })

  it('reports an older server bare 429 as rate limited without retrying', async () => {
    const artifacts = await service()
    const fetches = stubFetch(rateLimited(null))

    await expect(artifacts.share(writeRequest)).rejects.toThrow(
      'Artifact sharing is rate limited. Try again later.'
    )
    expect(fetches.keys).toHaveLength(1)
  })

  it('uses an older server Retry-After header for the wait it reports', async () => {
    const artifacts = await service()
    const fetches = stubFetch(rateLimited('120'))

    await expect(artifacts.share(writeRequest)).rejects.toThrow(
      'Artifact sharing is rate limited. Try again in 2 minutes.'
    )
    expect(fetches.keys).toHaveLength(1)
  })

  it('reads an HTTP-date Retry-After and replays when it is within a minute', async () => {
    const artifacts = await service()
    const retryAt = new Date(now.getTime() + 5_000).toUTCString()
    const fetches = stubFetch(rateLimited(retryAt), createdResponse())

    const shared = artifacts.share(writeRequest)
    await untilRetryScheduled()
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(shared).resolves.toBeTruthy()
    expect(fetches.keys).toHaveLength(2)
  })

  it('keeps server text from writing control sequences into the terminal', async () => {
    const artifacts = await service()
    stubFetch(rateLimited('900', { message: 'Slow down\u001b[2J\u0007 please' }))

    await expect(artifacts.share(writeRequest)).rejects.toThrow(
      'Slow down [2J please. Try again in 15 minutes.'
    )
  })
})
