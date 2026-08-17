import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { ArtifactCloudService } from './artifact-cloud-service'

const createdPaths: string[] = []
const apiUrl = 'http://localhost:3000'
const writeRequest = {
  sourceKey: '/repo/report.html',
  content: '<h1>Recovery</h1>',
  contentType: 'text/html' as const,
  fileName: 'report.html',
  apiUrl,
  authToken: 'token-a'
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('ArtifactCloudService committed response loss recovery', () => {
  it('reconciles one remotely revocable artifact after a committed create loses its response', async () => {
    const userDataPath = await createUserDataPath()
    const server = new ArtifactFaultServer()
    server.loseNextCreateResponse = true
    vi.stubGlobal('fetch', server.fetch)

    await expect(service(userDataPath).publish(writeRequest)).rejects.toThrow('response lost')
    expect(server.createMutations).toBe(1)
    expect(server.artifactSlugs()).toEqual(['artifact-1'])
    await expect(publishedLink(userDataPath)).resolves.toBeNull()

    await expect(
      service(userDataPath).publish({ ...writeRequest, content: '<h1>Changed after loss</h1>' })
    ).resolves.toMatchObject({
      status: 'ok',
      value: { item: { artifact: { slug: 'artifact-1' } } }
    })
    expect(server.createMutations).toBe(1)
    expect(server.artifactSlugs()).toEqual(['artifact-1'])
    expect(server.artifactContent('artifact-1')).toBe('<h1>Changed after loss</h1>')
    await expect(publishedLink(userDataPath)).resolves.toBe('https://share.onorca.dev/a/artifact-1')
  })

  it('replays the exact create when content is unchanged after response loss', async () => {
    const userDataPath = await createUserDataPath()
    const server = new ArtifactFaultServer()
    server.loseNextCreateResponse = true
    vi.stubGlobal('fetch', server.fetch)

    await expect(service(userDataPath).publish(writeRequest)).rejects.toThrow('response lost')
    await expect(service(userDataPath).publish(writeRequest)).resolves.toMatchObject({
      status: 'ok',
      value: { item: { artifact: { slug: 'artifact-1' } } }
    })
    expect(server.createMutations).toBe(1)
    expect(server.artifactContent('artifact-1')).toBe(writeRequest.content)
  })

  it('updates a recovered share when its content changed after response loss', async () => {
    const userDataPath = await createUserDataPath()
    const server = new ArtifactFaultServer()
    server.loseNextCreateResponse = true
    vi.stubGlobal('fetch', server.fetch)

    await expect(service(userDataPath).share(writeRequest)).rejects.toThrow('response lost')
    await expect(
      service(userDataPath).share({ ...writeRequest, content: '<h1>Changed share</h1>' })
    ).resolves.toMatchObject({
      status: 'ok',
      value: { artifact: { slug: 'artifact-1' } }
    })
    expect(server.createMutations).toBe(1)
    expect(server.artifactContent('artifact-1')).toBe('<h1>Changed share</h1>')
  })

  it('retains recovery until a changed-content update succeeds', async () => {
    const userDataPath = await createUserDataPath()
    const server = new ArtifactFaultServer()
    server.loseNextCreateResponse = true
    vi.stubGlobal('fetch', server.fetch)

    await expect(service(userDataPath).share(writeRequest)).rejects.toThrow('response lost')
    server.rejectNextUpdateStatus = 503
    const changed = { ...writeRequest, content: '<h1>Changed after update failure</h1>' }
    await expect(service(userDataPath).share(changed)).rejects.toMatchObject({ statusCode: 503 })
    await expect(service(userDataPath).share(changed)).resolves.toMatchObject({
      status: 'ok',
      value: { artifact: { slug: 'artifact-1' } }
    })
    expect(server.createMutations).toBe(1)
    expect(server.artifactSlugs()).toEqual(['artifact-1'])
    expect(server.artifactContent('artifact-1')).toBe(changed.content)
  })

  it('clears the durable mapping when a committed delete retry returns 404', async () => {
    const userDataPath = await createUserDataPath()
    const server = new ArtifactFaultServer()
    vi.stubGlobal('fetch', server.fetch)
    await service(userDataPath).publish(writeRequest)

    server.loseNextDeleteResponse = true
    await expect(
      service(userDataPath).unshare({
        sourceKey: writeRequest.sourceKey,
        apiUrl,
        authToken: 'token-a'
      })
    ).rejects.toThrow('response lost')
    expect(server.deleteMutations).toBe(1)
    expect(server.artifactSlugs()).toEqual([])
    await expect(publishedLink(userDataPath)).resolves.toBe('https://share.onorca.dev/a/artifact-1')

    await expect(
      service(userDataPath).unshare({
        sourceKey: writeRequest.sourceKey,
        apiUrl,
        authToken: 'token-a'
      })
    ).resolves.toEqual({ status: 'ok', value: undefined })
    expect(server.deleteMutations).toBe(1)
    expect(server.artifactSlugs()).toEqual([])
    await expect(publishedLink(userDataPath)).resolves.toBeNull()
  })

  it('keeps the durable mapping when a delete receives an unrelated 404', async () => {
    const userDataPath = await createUserDataPath()
    const server = new ArtifactFaultServer()
    vi.stubGlobal('fetch', server.fetch)
    await service(userDataPath).publish(writeRequest)

    server.rejectNextDeleteCode = 'not_found'
    await expect(
      service(userDataPath).unshare({
        sourceKey: writeRequest.sourceKey,
        apiUrl,
        authToken: 'token-a'
      })
    ).rejects.toMatchObject({ statusCode: 404, errorCode: 'not_found' })
    expect(server.deleteMutations).toBe(0)
    expect(server.artifactSlugs()).toEqual(['artifact-1'])
    await expect(publishedLink(userDataPath)).resolves.toBe('https://share.onorca.dev/a/artifact-1')
  })

  it('drops an uncommitted validation failure so corrected content can create', async () => {
    const userDataPath = await createUserDataPath()
    const server = new ArtifactFaultServer()
    server.rejectNextCreateStatus = 422
    vi.stubGlobal('fetch', server.fetch)

    await expect(service(userDataPath).publish(writeRequest)).rejects.toMatchObject({
      statusCode: 422
    })
    await expect(
      service(userDataPath).publish({ ...writeRequest, content: '<h1>Corrected</h1>' })
    ).resolves.toMatchObject({
      status: 'ok',
      value: { item: { artifact: { slug: 'artifact-1' } } }
    })
    expect(server.createMutations).toBe(1)
    expect(server.artifactContent('artifact-1')).toBe('<h1>Corrected</h1>')
  })

  it('keeps a replay intent when validation changes after the original commit', async () => {
    const userDataPath = await createUserDataPath()
    const server = new ArtifactFaultServer()
    server.loseNextCreateResponse = true
    vi.stubGlobal('fetch', server.fetch)

    await expect(service(userDataPath).publish(writeRequest)).rejects.toThrow('response lost')
    server.rejectNextCreateStatus = 422
    const changed = { ...writeRequest, content: '<h1>Changed after validation</h1>' }
    await expect(service(userDataPath).publish(changed)).rejects.toMatchObject({ statusCode: 422 })
    await expect(service(userDataPath).publish(changed)).resolves.toMatchObject({
      status: 'ok',
      value: { item: { artifact: { slug: 'artifact-1' } } }
    })
    expect(server.createMutations).toBe(1)
    expect(server.artifactContent('artifact-1')).toBe(changed.content)
  })
})

class ArtifactFaultServer {
  readonly fetch = vi.fn(this.handle.bind(this))
  createMutations = 0
  deleteMutations = 0
  loseNextCreateResponse = false
  loseNextDeleteResponse = false
  rejectNextCreateStatus: number | null = null
  rejectNextDeleteCode: string | null = null
  rejectNextUpdateStatus: number | null = null
  private readonly artifacts = new Map<string, string>()
  private readonly createsByKey = new Map<string, { body: string; response: object }>()

  artifactSlugs(): string[] {
    return [...this.artifacts.keys()].sort()
  }

  artifactContent(slug: string): string | undefined {
    const body = this.artifacts.get(slug)
    return body ? (JSON.parse(body) as { content?: string }).content : undefined
  }

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET'
    if (method === 'POST') {
      return this.create(init)
    }
    if (method === 'PUT') {
      return this.update(String(input), init)
    }
    if (method === 'DELETE') {
      return this.delete(String(input))
    }
    throw new Error(`Unexpected artifact request: ${method} ${String(input)}`)
  }

  private create(init?: RequestInit): Response {
    if (this.rejectNextCreateStatus !== null) {
      const status = this.rejectNextCreateStatus
      this.rejectNextCreateStatus = null
      return jsonResponse({ code: 'artifact_validation_failed' }, status)
    }
    const key = new Headers(init?.headers).get('idempotency-key')
    if (new Headers(init?.headers).get('authorization') !== 'Bearer token-a') {
      throw new Error('Missing artifact authorization')
    }
    if (!key) {
      throw new Error('Missing idempotency key')
    }
    const body = String(init?.body)
    const existing = this.createsByKey.get(key)
    if (existing) {
      if (existing.body !== body) {
        throw new Error('Idempotency key reused with another request')
      }
      return jsonResponse(existing.response, 201)
    }

    this.createMutations += 1
    const slug = `artifact-${this.createMutations}`
    const response = createResponseBody(slug)
    this.createsByKey.set(key, { body, response })
    this.artifacts.set(slug, body)
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false
      throw new TypeError('response lost after committed create')
    }
    return jsonResponse(response, 201)
  }

  private delete(url: string): Response {
    if (this.rejectNextDeleteCode !== null) {
      const code = this.rejectNextDeleteCode
      this.rejectNextDeleteCode = null
      return jsonResponse({ code }, 404)
    }
    const slug = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
    if (!this.artifacts.delete(slug)) {
      return jsonResponse({ code: 'artifact_not_found' }, 404)
    }
    this.deleteMutations += 1
    if (this.loseNextDeleteResponse) {
      this.loseNextDeleteResponse = false
      throw new TypeError('response lost after committed delete')
    }
    return new Response(null, { status: 204 })
  }

  private update(url: string, init?: RequestInit): Response {
    if (this.rejectNextUpdateStatus !== null) {
      const status = this.rejectNextUpdateStatus
      this.rejectNextUpdateStatus = null
      return jsonResponse({ code: 'artifact_update_failed' }, status)
    }
    const slug = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
    if (!this.artifacts.has(slug)) {
      return jsonResponse({ code: 'artifact_not_found' }, 404)
    }
    const headers = new Headers(init?.headers)
    if (
      headers.get('authorization') !== 'Bearer token-a' ||
      headers.get('x-orca-edit-token') !== `edit-${slug}`
    ) {
      return jsonResponse({ code: 'artifact_forbidden' }, 403)
    }
    this.artifacts.set(slug, String(init?.body))
    return jsonResponse(createResponseBody(slug), 200)
  }
}

async function createUserDataPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-artifact-recovery-'))
  createdPaths.push(path)
  return path
}

function service(userDataPath: string): ArtifactCloudService {
  return new ArtifactCloudService(userDataPath, () => true)
}

async function publishedLink(userDataPath: string): Promise<string | null> {
  const result = await service(userDataPath).getPublishedLink({
    sourceKey: writeRequest.sourceKey,
    apiUrl,
    authToken: 'token-a'
  })
  return result.status === 'ok' ? (result.value?.shareUrl ?? null) : null
}

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function createResponseBody(slug: string): object {
  return {
    artifact: {
      version: 1,
      slug,
      title: null,
      originalFileName: 'report.html',
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
      expiresAt: '2026-09-06T00:00:00.000Z',
      byteSize: 17,
      deletedAt: null
    },
    shareUrl: `https://share.onorca.dev/a/${slug}`,
    editToken: `edit-${slug}`
  }
}
