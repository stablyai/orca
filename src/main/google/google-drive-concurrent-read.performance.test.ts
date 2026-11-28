import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { googleApi, EMAIL, NOW } from './google-api-http.test-fixture'

const { readDrive } = await import('./google-drive-read')

afterEach(() => vi.useRealTimers())

// Incident: PR #50594 — concurrent reads downloaded the same unchanged Drive file more than once.

it('shares concurrent reads of one version and retries a failed download', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  const release = Promise.withResolvers<void>()
  const metadataRead = Promise.withResolvers<void>()
  let metadataCount = 0
  let downloads = 0
  const api = await googleApi(EMAIL, {
    now: () => NOW,
    http: async (input) => {
      const url = new URL(String(input))
      if (url.searchParams.get('alt') === 'media') {
        downloads++
        await release.promise
        return new Response('The same saved file.')
      }
      if (++metadataCount === 2) {
        metadataRead.resolve()
      }
      return Response.json({
        id: 'concurrent-document-123',
        name: 'Notes.txt',
        mimeType: 'text/plain',
        modifiedTime: '2026-01-01T00:00:00Z'
      })
    }
  })
  const reads = Promise.all([
    readDrive(api, { ref: 'concurrent-document-123' }),
    readDrive(api, { ref: 'concurrent-document-123', offset: 4 })
  ])
  await metadataRead.promise
  await setImmediate()
  release.resolve()
  const [first, later] = await reads

  expect(first.text).toBe('The same saved file.')
  expect(later.text).toBe('same saved file.')
  expect(downloads).toBe(1)

  let available = false
  const recoveryApi = await googleApi(EMAIL, {
    now: () => NOW,
    http: async (input) => {
      if (new URL(String(input)).searchParams.get('alt') === 'media') {
        return available ? new Response('Recovered file.') : new Response('', { status: 503 })
      }
      return Response.json({
        id: 'retry-document-123456',
        name: 'Notes.txt',
        mimeType: 'text/plain',
        modifiedTime: '2026-01-01T00:00:00Z'
      })
    }
  })

  await expect(readDrive(recoveryApi, { ref: 'retry-document-123456' })).rejects.toThrow(
    'Google refused'
  )
  available = true
  expect((await readDrive(recoveryApi, { ref: 'retry-document-123456' })).text).toBe(
    'Recovered file.'
  )
})
