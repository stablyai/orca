import { test } from 'node:test'
import assert from 'node:assert/strict'
import activate from './main.mjs'

function harness() {
  const storage = new Map()
  const requests = []
  let command
  let loseReply = true
  activate({
    commands: {
      register: (_id, fn) => {
        command = fn
      }
    },
    host: {
      has: () => true,
      async call(method, params) {
        if (method === 'chat.list') {
          return [{ sessionId: 'chat-1' }]
        }
        if (method === 'chat.readContext') {
          return { fence: 1, cursor: { epoch: 'e', sequence: 5 }, transcript: 'user: latest words' }
        }
        if (method === 'storage.get') {
          return { value: storage.get(params.key) ?? null }
        }
        if (method === 'storage.set') {
          storage.set(params.key, params.value)
          return { ok: true }
        }
        if (method === 'storage.delete') {
          storage.delete(params.key)
          return { ok: true }
        }
        if (method === 'chat.handoff') {
          requests.push(params)
          if (loseReply) {
            loseReply = false
            throw new Error('lost response')
          }
          return { completed: true }
        }
        throw new Error(method)
      }
    }
  })
  return { command, requests, storage }
}

test('retries the same durable operation after a lost handoff reply', async () => {
  const h = harness()
  await assert.rejects(h.command(), /lost response/)
  assert.equal(h.storage.size, 1)
  assert.match(await h.command(), /Context handed off/)
  assert.deepEqual(h.requests[0], h.requests[1])
  assert.equal(h.storage.size, 0)
})

test('refuses an externally generated summary without its original cursor', async () => {
  const h = harness()
  assert.match(await h.command({ context: 'old summary' }), /cursor and fence/)
  assert.equal(h.requests.length, 0)
})
