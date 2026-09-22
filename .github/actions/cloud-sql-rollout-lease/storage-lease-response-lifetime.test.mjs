import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { CloudSqlRolloutLease } from './storage-lease.mjs'

const holder = { holderKey: 'fixture-holder' }
const record = { holder_key: holder.holderKey, acquired_at: 1, expires_at: 10_000 }
const cases = [
  ['metadata', 404, 'read', null],
  ['metadata', 503, 'read', /lease inspection failed: 503/],
  ['body', 404, 'read', null],
  ['body', 503, 'read', /lease body read failed: 503/],
  ['write', 412, 'acquire', /changed concurrently/],
  ['write', 503, 'acquire', /lease write failed: 503/],
  ['delete', 200, 'release', { released: true, generation: '1' }],
  ['delete', 404, 'release', { released: true, generation: '1' }],
  ['delete', 412, 'release', { released: false, reason: 'conflict' }],
  ['delete', 503, 'release', /lease release failed: 503/]
]

for (const [stage, status, operation, expected] of cases) {
  test(`releases the ${String(stage)} response after status ${String(status)}`, async () => {
    let activeResponses = 0
    let closed = Promise.withResolvers()
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost')
      const currentStage =
        request.method === 'DELETE'
          ? 'delete'
          : request.method === 'POST'
            ? 'write'
            : url.searchParams.has('alt')
              ? 'body'
              : 'metadata'
      if (currentStage !== stage) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(currentStage === 'body' ? record : { generation: '1' }))
        return
      }
      activeResponses++
      const thisResponseClosed = closed
      response.once('close', () => {
        activeResponses--
        thisResponseClosed.resolve()
      })
      response.writeHead(status, { 'content-type': 'application/json' })
      response.write('{')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const lease = new CloudSqlRolloutLease({
        bucket: 'fixture-bucket',
        objectName: 'fixture-object',
        accessToken: 'test-token',
        now: () => 1000,
        fetcher: (rawUrl, init) => {
          const url = new URL(rawUrl)
          return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init)
        }
      })
      for (let attempt = 0; attempt < 10; attempt++) {
        closed = Promise.withResolvers()
        const result = lease[operation](operation === 'acquire' ? holder : holder.holderKey)
        if (expected instanceof RegExp) await assert.rejects(result, expected)
        else assert.deepEqual(await result, expected)
        await expectClosed(closed.promise)
        assert.equal(activeResponses, 0)
      }
    } finally {
      server.closeAllConnections()
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
}

async function expectClosed(closed) {
  let timer
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('unused response remains open')), 1000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
