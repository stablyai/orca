import { describe, expect, it, vi } from 'vitest'
import { readCloudRunInstanceZone } from './cloud-run-instance-zone.js'

const answering = (status: number, body: string): typeof fetch =>
  vi.fn(async () => new Response(body, { status }))

describe('readCloudRunInstanceZone', () => {
  it('returns the zone from the metadata path', async () => {
    const fetchImpl = answering(200, 'projects/123456/zones/us-central1-f')
    await expect(readCloudRunInstanceZone(fetchImpl)).resolves.toBe('us-central1-f')
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://metadata.google.internal/computeMetadata/v1/instance/zone',
      expect.objectContaining({ headers: { 'Metadata-Flavor': 'Google' } })
    )
  })

  it('returns undefined when the metadata server refuses or is unreachable', async () => {
    await expect(readCloudRunInstanceZone(answering(404, 'not found'))).resolves.toBeUndefined()
    const unreachable: typeof fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(readCloudRunInstanceZone(unreachable)).resolves.toBeUndefined()
  })

  it('returns undefined for a body that is not a zone name', async () => {
    await expect(readCloudRunInstanceZone(answering(200, '<html>'))).resolves.toBeUndefined()
  })
})
