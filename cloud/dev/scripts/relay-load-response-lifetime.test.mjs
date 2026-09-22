import assert from 'node:assert/strict'
import test from 'node:test'
import {
  waitForRelayLoadDirectorCapacity,
  waitForRelayLoadRequestUnits
} from './relay-load-director-capacity-gate.mjs'
import { readRelayLoadRuntimeQueuedBytes } from './relay-load-reader-evidence.mjs'

const origin = 'https://director.test'
const claims = Buffer.from(
  JSON.stringify({
    aud: `${origin}/v1/admin/drain`,
    email: 'capacity@example.test',
    email_verified: true,
    exp: 4_000_000_000
  })
).toString('base64url')
const config = { directorOrigin: origin, adminToken: `header.${claims}.signature` }

async function within(operation) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('discarded response was left streaming')), 100)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function streamingResponses(context, status) {
  const active = new Set()
  let canceled = 0
  context.after(() => {
    for (const controller of active) controller.close()
    active.clear()
  })
  return {
    active,
    get canceled() {
      return canceled
    },
    fetch: async () => {
      let controller
      const body = new ReadableStream({
        start(value) {
          controller = value
          active.add(controller)
          controller.enqueue(new TextEncoder().encode('unused response bytes'))
        },
        cancel() {
          active.delete(controller)
          canceled++
        }
      })
      return new Response(body, { status })
    }
  }
}

for (const gate of [waitForRelayLoadDirectorCapacity, waitForRelayLoadRequestUnits]) {
  for (const status of [401, 403, 503]) {
    test(`${gate.name} releases streaming ${status} responses`, async (context) => {
      const responses = streamingResponses(context, status)
      for (let cycle = 0; cycle < 10; cycle++) {
        let elapsed = 0
        const operation = gate(config, {
          fetch: responses.fetch,
          delay: async () => {
            elapsed += 1
          },
          now: () => elapsed,
          timeoutMs: 1
        })
        await assert.rejects(
          within(operation),
          status === 503 ? /did not converge/ : /identity was rejected/
        )
        assert.equal(responses.active.size, 0)
      }
      assert.equal(responses.canceled, status === 503 ? 20 : 10)
    })
  }
}

for (const status of [401, 403, 503]) {
  test(`runtime reader evidence releases streaming ${status} responses`, async (context) => {
    const responses = streamingResponses(context, status)
    for (let cycle = 0; cycle < 10; cycle++) {
      await assert.rejects(
        within(readRelayLoadRuntimeQueuedBytes(origin, config.adminToken, responses.fetch)),
        status === 503 ? /runtime status returned 503/ : /identity was rejected/
      )
      assert.equal(responses.active.size, 0)
    }
    assert.equal(responses.canceled, 10)
  })
}

test('cancellation failure preserves identity rejection', async () => {
  const fetch = async () => ({
    ok: false,
    status: 403,
    body: {
      cancel: async () => {
        throw new Error('cancel failed')
      }
    }
  })
  await assert.rejects(waitForRelayLoadDirectorCapacity(config, { fetch }), /identity was rejected/)
  await assert.rejects(waitForRelayLoadRequestUnits(config, { fetch }), /identity was rejected/)
  await assert.rejects(
    readRelayLoadRuntimeQueuedBytes(origin, config.adminToken, fetch),
    /identity was rejected/
  )
})

test('runtime reader evidence consumes successful responses', async () => {
  assert.equal(
    await readRelayLoadRuntimeQueuedBytes(origin, config.adminToken, async () =>
      Response.json({ runtime: { queuedBytes: 42 } })
    ),
    42
  )
  await assert.rejects(
    readRelayLoadRuntimeQueuedBytes(origin, config.adminToken, async () =>
      Response.json({ runtime: { queuedBytes: -1 } })
    ),
    /queued bytes are invalid/
  )
})
