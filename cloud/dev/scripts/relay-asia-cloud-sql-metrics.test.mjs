import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { readCloudSqlBackends } from './relay-asia-cloud-sql-metrics.mjs'

const startedAt = '2026-09-22T10:00:00Z'
const endedAt = '2026-09-22T10:05:00Z'
const token = 'test-access-token-for-local-fixtures'

function mockAccessToken(context) {
  const spawn = context.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.equal(command, 'gcloud')
    assert.deepEqual(args, ['auth', 'print-access-token'])
    assert.equal(options.timeout, 30_000)
    return { status: 0, stdout: `${token}\n` }
  })
  syncBuiltinESMExports()
  context.after(() => {
    spawn.mock.restore()
    syncBuiltinESMExports()
  })
  return spawn
}

for (const status of [401, 403, 429, 500, 503]) {
  test(`cancels unused Cloud SQL metric ${status} responses`, async (context) => {
    const spawn = mockAccessToken(context)
    const active = new Set()
    let canceled = 0
    context.after(() => {
      for (const stream of active) stream.close()
      active.clear()
    })
    context.mock.method(globalThis, 'fetch', async () => {
      let controller
      return new Response(new ReadableStream({
        start(stream) {
          controller = stream
          active.add(stream)
          stream.enqueue(new TextEncoder().encode('unused error response'))
        },
        cancel() {
          active.delete(controller)
          canceled++
        }
      }), { status })
    })
    for (let cycle = 0; cycle < 10; cycle++) {
      await assert.rejects(
        readCloudSqlBackends('staging', startedAt, endedAt),
        new RegExp(`Cloud SQL metric query returned ${status}`)
      )
      assert.equal(active.size, 0)
    }
    assert.equal(canceled, 10)
    assert.equal(spawn.mock.callCount(), 10)
  })
}

for (const environment of ['production', 'staging']) {
  test(`consumes ${environment} metric JSON with the existing query`, async (context) => {
    mockAccessToken(context)
    const project = environment === 'production' ? 'onorca-cloud' : 'onorca-cloud-staging'
    const body = { timeSeries: [{ points: [{ value: { int64Value: '17' } }] }] }
    const response = Response.json(body)
    context.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url.origin, 'https://monitoring.googleapis.com')
      assert.equal(url.pathname, `/v3/projects/${project}/timeSeries`)
      assert.match(url.searchParams.get('filter'), /postgresql\/num_backends/)
      assert.ok(url.searchParams.get('filter').includes(`${project}:`))
      assert.equal(url.searchParams.get('interval.startTime'), startedAt)
      assert.equal(url.searchParams.get('interval.endTime'), endedAt)
      assert.equal(url.searchParams.get('aggregation.crossSeriesReducer'), 'REDUCE_MAX')
      assert.equal(options.headers.authorization, `Bearer ${token}`)
      assert.equal(options.redirect, 'error')
      assert.equal(options.signal.aborted, false)
      return response
    })
    assert.deepEqual(await readCloudSqlBackends(environment, startedAt, endedAt), body)
    assert.equal(response.bodyUsed, true)
  })
}

test('cancellation failure preserves the metric status error', async (context) => {
  mockAccessToken(context)
  let canceled = 0
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() {
      canceled++
      throw new Error('cancel failed')
    }
  }), { status: 403 }))
  await assert.rejects(
    readCloudSqlBackends('production', startedAt, endedAt),
    /Cloud SQL metric query returned 403/
  )
  assert.equal(canceled, 1)
})
