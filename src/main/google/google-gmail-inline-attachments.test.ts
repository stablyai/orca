import { expect, it } from 'vitest'
import { googleApi, EMAIL, NOW } from './google-api-http.test-fixture'

const { readGmail, downloadGmailAttachment } = await import('./google-gmail-read')
const { composeForward } = await import('./google-gmail-draft-compose')

it('keeps inline and empty attachment bytes in message reads, downloads and forwarded drafts', async () => {
  const id = '1234567890abcdef'
  const inline = Buffer.from([0, 255, 1, 254])
  const remote = Buffer.from('remote contents')
  const message = {
    id,
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
          filename: 'empty.txt',
          mimeType: 'text/plain',
          body: { data: '', size: 0 }
        },
        {
          partId: '3',
          filename: 'remote.txt',
          mimeType: 'text/plain',
          body: { attachmentId: 'remote', size: remote.length }
        },
        { partId: '4', filename: 'unavailable.txt', body: { size: 1 } }
      ]
    }
  }
  const api = await googleApi(EMAIL, {
    now: () => NOW,
    http: async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith(`/messages/${id}`)) {
        return Response.json(message)
      }
      if (path.endsWith(`/messages/${id}/attachments/remote`)) {
        return Response.json({ data: remote.toString('base64url'), size: remote.length })
      }
      throw new Error(`Unexpected Gmail request: ${path}`)
    }
  })

  const result = await readGmail(api, { ref: `gmail:msg:${id}` })
  expect(result.messages[0]?.attachments.map((file) => file.name)).toEqual([
    'inline.bin',
    'empty.txt',
    'remote.txt'
  ])
  expect(result.messages[0]?.body).toBe('Hello')
  for (const [part, bytes] of [inline, Buffer.alloc(0), remote].entries()) {
    const file = await downloadGmailAttachment(api, `gmail:att:${id}:${part + 1}`)
    expect(Buffer.from(file.data, 'base64')).toEqual(bytes)
  }
  const draft = await composeForward(api, {
    to: ['recipient@example.com'],
    cc: [],
    bcc: [],
    attachments: [],
    forward: `gmail:msg:${id}`
  })
  expect(draft.mime.attachments).toEqual([
    { name: 'inline.bin', type: 'application/octet-stream', data: inline },
    { name: 'empty.txt', type: 'text/plain', data: Buffer.alloc(0) },
    { name: 'remote.txt', type: 'text/plain', data: remote }
  ])
})
