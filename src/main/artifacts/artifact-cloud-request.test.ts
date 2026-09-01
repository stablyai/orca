import { afterEach, describe, expect, it, vi } from 'vitest'
import { artifactRequest, deleteArtifactRequest } from './artifact-cloud-request'

describe('artifact cloud request errors', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses the server error discriminator for missing artifacts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'artifact_not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })
    )

    await expect(
      artifactRequest('https://api.onorca.dev', 'token', '/missing')
    ).rejects.toMatchObject({ statusCode: 404, errorCode: 'artifact_not_found' })
  })

  it('treats a server-reported missing artifact as an idempotent delete', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'artifact_not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })
    )

    await expect(
      deleteArtifactRequest('https://api.onorca.dev', 'token', '/missing')
    ).resolves.toBeUndefined()
  })
})
