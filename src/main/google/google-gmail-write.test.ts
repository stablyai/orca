import { expect, it } from 'vitest'
import { GoogleToolError, type GoogleApi } from './google-api-client'
import { modifyGmail } from './google-gmail-write'

function readOrThrow<T>(value: T | null): T {
  if (value === null) {
    throw new Error('unreadable fake response')
  }
  return value
}

it('creates a label named twice in one request once and applies it', async () => {
  const labels = [{ id: 'Label_existing', name: 'Existing', type: 'user' }]
  const writes: { url: string; json?: unknown }[] = []
  const api: GoogleApi = {
    email: 'reader@example.com',
    get: async (_service, _url, read) => readOrThrow(read({ labels: [...labels] })),
    find: async () => null,
    send: async (_service, write, read) => {
      writes.push({ url: write.url, json: write.json })
      if (!write.url.endsWith('/labels')) {
        return readOrThrow(read(null))
      }
      const body = write.json
      const name = typeof body === 'object' && body && 'name' in body ? String(body.name) : ''
      // Gmail refuses a second label whose name matches case-insensitively.
      if (labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) {
        throw new GoogleToolError('Google refused: Label name exists or conflicts', 409)
      }
      const label = { id: `Label_${labels.length}`, name, type: 'user' }
      labels.push(label)
      return readOrThrow(read(label))
    },
    bytes: async () => new Uint8Array()
  }

  const result = await modifyGmail(api, {
    refs: ['gmail:msg:1234567890abcdef'],
    add: ['Project', ' project ', 'Existing'],
    remove: []
  })

  expect(result.created).toEqual(['Project'])
  expect(writes.filter((write) => write.url.endsWith('/labels'))).toHaveLength(1)
  expect(writes.at(-1)?.json).toMatchObject({
    addLabelIds: ['Label_1', 'Label_1', 'Label_existing']
  })
})
