import { expect, it } from 'vitest'
import { composeForward } from './google-gmail-draft-compose'
import { GoogleToolError, type GoogleApi } from './google-api-client'

const unexpected = async (): Promise<never> => {
  throw new Error('Unexpected call')
}

it('forwards many attachments without exceeding Gmail per-user concurrency', async () => {
  let active = 0
  const get: GoogleApi['get'] = async (_service, url, read) => {
    active++
    try {
      // Gmail answers 429 once a user has too many requests in flight.
      if (active > 10) {
        throw new GoogleToolError('Too many concurrent requests for user', 429)
      }
      await Promise.resolve()
      const value = read(
        url.includes('/attachments/')
          ? { data: 'aGVsbG8', size: 5 }
          : {
              id: '1234567890abcdef',
              threadId: 'fedcba0987654321',
              payload: {
                mimeType: 'multipart/mixed',
                parts: Array.from({ length: 12 }, (_, index) => ({
                  partId: String(index + 1),
                  filename: `part-${index + 1}.txt`,
                  mimeType: 'text/plain',
                  body: { attachmentId: `attachment-${index + 1}`, size: 5 }
                }))
              }
            }
      )
      if (value === null) {
        throw new Error('Unexpected Gmail response shape')
      }
      return value
    } finally {
      active--
    }
  }
  const api: GoogleApi = {
    email: 'sender@example.com',
    get,
    find: unexpected,
    send: unexpected,
    bytes: unexpected
  }

  const { mime } = await composeForward(api, {
    to: ['recipient@example.com'],
    cc: [],
    bcc: [],
    attachments: [],
    forward: 'gmail:msg:1234567890abcdef'
  })

  expect(mime.attachments).toHaveLength(12)
  expect(mime.attachments[0]).toEqual({
    name: 'part-1.txt',
    type: 'text/plain',
    data: Buffer.from('hello')
  })
  expect(mime.attachments[11]?.name).toBe('part-12.txt')
})

it('forwards attachments whose bytes Gmail returns in the part body', async () => {
  const inline = Buffer.from([0, 255, 1, 254])
  const remote = Buffer.from('remote contents')
  const get: GoogleApi['get'] = async (_service, url, read) => {
    const value = read(
      url.endsWith('/attachments/remote')
        ? { data: remote.toString('base64url') }
        : {
            id: '1234567890abcdef',
            threadId: 'fedcba0987654321',
            payload: {
              mimeType: 'multipart/mixed',
              parts: [
                { partId: '0', mimeType: 'text/plain', body: { data: 'SGVsbG8' } },
                {
                  partId: '1',
                  filename: 'inline.bin',
                  mimeType: 'application/octet-stream',
                  body: { data: inline.toString('base64url'), size: inline.length }
                },
                {
                  partId: '2',
                  filename: 'remote.txt',
                  mimeType: 'text/plain',
                  body: { attachmentId: 'remote', size: remote.length }
                },
                { partId: '3', filename: 'unavailable.txt', body: { size: 1 } }
              ]
            }
          }
    )
    if (value === null) {
      throw new Error('Unexpected Gmail response shape')
    }
    return value
  }
  const api: GoogleApi = {
    email: 'sender@example.com',
    get,
    find: unexpected,
    send: unexpected,
    bytes: unexpected
  }

  const { mime } = await composeForward(api, {
    to: ['recipient@example.com'],
    cc: [],
    bcc: [],
    attachments: [],
    forward: 'gmail:msg:1234567890abcdef'
  })

  expect(mime.attachments).toEqual([
    { name: 'inline.bin', type: 'application/octet-stream', data: inline },
    { name: 'remote.txt', type: 'text/plain', data: remote }
  ])
})
