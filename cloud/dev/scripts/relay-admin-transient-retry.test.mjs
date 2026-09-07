import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchAdminOnceMore } from './relay-admin-transient-retry.mjs'

const url = 'https://relay.onorca.dev/v1/admin/cell-status'
const init = { method: 'POST', body: '{"v":1}' }

function recordingWait(waits) {
  return async (ms) => { waits.push(ms) }
}

test('a single transient 5xx is retried and the second answer is returned', async () => {
  const waits = []
  const statuses = [503, 200]
  let calls = 0
  const response = await fetchAdminOnceMore(
    async () => {
      calls += 1
      const status = statuses.shift()
      return new Response(JSON.stringify({ ok: status === 200 }), { status })
    },
    url,
    init,
    { wait: recordingWait(waits) }
  )
  assert.equal(calls, 2)
  assert.equal(response.status, 200)
  assert.deepEqual(waits, [2_000])
  assert.deepEqual(await response.json(), { ok: true })
})

test('a connection failure is retried and the second answer is returned', async () => {
  const waits = []
  let calls = 0
  const response = await fetchAdminOnceMore(
    async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return Response.json({ ok: true })
    },
    url,
    init,
    { wait: recordingWait(waits) }
  )
  assert.equal(calls, 2)
  assert.equal(response.status, 200)
  assert.deepEqual(waits, [2_000])
})

test('two transient failures surface the second answer without a third attempt', async () => {
  let calls = 0
  const response = await fetchAdminOnceMore(
    async () => {
      calls += 1
      return new Response('down', { status: 503 })
    },
    url,
    init,
    { wait: async () => {} }
  )
  assert.equal(calls, 2)
  assert.equal(response.status, 503)
})

test('two connection failures rethrow the second error', async () => {
  let calls = 0
  await assert.rejects(
    fetchAdminOnceMore(
      async () => {
        calls += 1
        throw new TypeError(`fetch failed ${calls}`)
      },
      url,
      init,
      { wait: async () => {} }
    ),
    /fetch failed 2/
  )
  assert.equal(calls, 2)
})

test('4xx is final: auth and generation-mismatch answers are never retried', async () => {
  for (const status of [400, 401, 403, 404, 409, 429]) {
    let calls = 0
    const response = await fetchAdminOnceMore(
      async () => {
        calls += 1
        return new Response('no', { status })
      },
      url,
      init,
      { wait: async () => { throw new Error('must not wait') } }
    )
    assert.equal(calls, 1, `status ${status} must not be retried`)
    assert.equal(response.status, status)
  }
})

test('each attempt carries its own unexpired timeout signal', async () => {
  const signals = []
  await fetchAdminOnceMore(
    async (_url, attemptInit) => {
      signals.push(attemptInit.signal)
      return new Response('down', { status: 502 })
    },
    url,
    init,
    { wait: async () => {}, timeoutMs: 30_000 }
  )
  assert.equal(signals.length, 2)
  assert.notEqual(signals[0], signals[1])
  assert.equal(signals[1].aborted, false)
})

test('the caller init is forwarded unchanged apart from the signal', async () => {
  let seen
  await fetchAdminOnceMore(
    async (seenUrl, attemptInit) => {
      seen = { seenUrl, attemptInit }
      return Response.json({})
    },
    url,
    { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{"v":1}' },
    { wait: async () => {} }
  )
  assert.equal(seen.seenUrl, url)
  assert.equal(seen.attemptInit.method, 'POST')
  assert.deepEqual(seen.attemptInit.headers, { authorization: 'Bearer t' })
  assert.equal(seen.attemptInit.body, '{"v":1}')
})
