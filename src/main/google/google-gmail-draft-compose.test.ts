import { expect, it } from 'vitest'
import { composeForward } from './google-gmail-draft-compose'
import { GoogleToolError, type GoogleApi } from './google-api-client'

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
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected call')
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
