import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchAdminOnceMore } from './relay-admin-transient-retry.mjs'
import { verifyCapacityTransition } from './verify-relay-capacity-transition.mjs'

function streamingResponse(context, status) {
  let controller
  let canceled = false
  const response = new Response(new ReadableStream({
    start(value) {
      controller = value
      controller.enqueue(new TextEncoder().encode('discarded response bytes'))
    },
    cancel() {
      canceled = true
    }
  }), { status })
  context.after(() => {
    if (!canceled) controller.close()
  })
  return { response, isCanceled: () => canceled }
}

async function within(operation) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('discarded response is still streaming')), 100)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const status of [500, 502, 503, 504]) {
  test(`admin retry cancels streaming ${status} before waiting`, async (context) => {
    for (let cycle = 0; cycle < 10; cycle++) {
      const first = streamingResponse(context, status)
      const second = Response.json({ ok: true })
      let calls = 0
      let canceledBeforeWait = false
      const result = await within(fetchAdminOnceMore(
        async () => ++calls === 1 ? first.response : second,
        'https://director.test/health',
        {},
        { wait: async () => { canceledBeforeWait = first.isCanceled() } }
      ))
      assert.equal(calls, 2)
      assert.equal(canceledBeforeWait, true)
      assert.equal(result, second)
      assert.equal(result.bodyUsed, false)
      assert.deepEqual(await result.json(), { ok: true })
    }
  })
}

for (const status of [502, 503, 504]) {
  test(`capacity verification cancels streaming runtime ${status}`, async (context) => {
    for (let cycle = 0; cycle < 10; cycle++) {
      const runtime = streamingResponse(context, status)
      await assert.rejects(within(verifyCapacityTransition({
        directorOrigin: 'https://director.test',
        cellOrigin: 'https://cell.test',
        runtime: 'required',
        timeoutMs: 0
      }, {
        token: 'test-admin-token',
        now: () => 0,
        wait: async () => { throw new Error('must not wait after the deadline') },
        fetch: async (url) => new URL(url).pathname === '/health'
          ? Response.json({ ok: true, connectionCapacityProtocol: 2 })
          : runtime.response
      })), /capacity transition verification timed out: \{"runtimeAvailable":false\}/)
      assert.equal(runtime.isCanceled(), true)
    }
  })
}

test('a rejected cancellation does not prevent the admin retry', async () => {
  let calls = 0
  let canceled = 0
  const result = await fetchAdminOnceMore(async () => {
    if (++calls === 2) return Response.json({ ok: true })
    return {
      status: 503,
      body: {
        cancel: async () => {
          canceled++
          throw new Error('cancel failed')
        }
      }
    }
  }, 'https://director.test/health', {}, { wait: async () => {} })
  assert.equal(canceled, 1)
  assert.equal(calls, 2)
  assert.deepEqual(await result.json(), { ok: true })
})
