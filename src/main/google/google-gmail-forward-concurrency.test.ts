import { expect, it } from 'vitest'
import { composeForward } from './google-gmail-draft-compose'
import { GoogleToolError, type GoogleApi } from './google-api-client'

it('forwards many small attachments without exceeding the Gmail request allowance', async () => {
  let active = 0
  let filenames = Array.from({ length: 12 }, (_, index) => `part-${index + 1}.txt`)
  const get: GoogleApi['get'] = async (_service, url, read) => {
    active++
    try {
      if (active > 10) {
        throw new GoogleToolError('Too many concurrent requests for user', 429)
      }
      await Promise.resolve()
      const body = url.includes('/attachments/')
        ? { data: 'aGVsbG8', size: 5 }
        : {
            id: '1234567890abcdef',
            threadId: 'fedcba0987654321',
            payload: {
              mimeType: 'multipart/mixed',
              parts: filenames.map((filename, index) => ({
                partId: String(index + 1),
                filename,
                mimeType: 'text/plain',
                body: { attachmentId: `attachment-${index + 1}`, size: 5 }
              }))
            }
          }
      const value = read(body)
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
    find: async () => {
      throw new Error('Unexpected lookup')
    },
    send: async () => {
      throw new Error('Unexpected write')
    },
    bytes: async () => {
      throw new Error('Unexpected download')
    }
  }
  const args = {
    to: ['recipient@example.com'],
    cc: [],
    bcc: [],
    attachments: [],
    forward: 'gmail:msg:1234567890abcdef'
  }
  const result = await composeForward(api, args)
  expect(result.mime.attachments).toHaveLength(12)
  expect(result.mime.attachments[0]).toEqual({
    name: 'part-1.txt',
    type: 'text/plain',
    data: Buffer.from('hello')
  })
  expect(result.mime.attachments[11]?.name).toBe('part-12.txt')

  filenames = ['single.txt']
  expect((await composeForward(api, args)).mime.attachments).toEqual([
    { name: 'single.txt', type: 'text/plain', data: Buffer.from('hello') }
  ])
})
