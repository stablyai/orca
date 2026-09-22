import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAccessTokenSource } from './gcloud-access-token.mjs'
import {
  CloudSqlRolloutLease,
  LEASE_TTL_MS,
  LeaseConflict,
  LeaseUnreadable
} from './storage-lease.mjs'

const BUCKET = 'onorca-cloud-terraform-state'
const OBJECT = 'terraform/state/cloud-sql-rollout/production.lock'
const NOW = 1_756_000_000_000

/**
 * Enough of the Cloud Storage JSON API to exercise real compare-and-swap semantics: generations
 * increment, ifGenerationMatch is enforced, and a mismatch is a 412. `faults` injects failures.
 */
function fakeStorage({ object = null, faults = [] } = {}) {
  const state = { object, requests: [] }
  const fetcher = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl)
    const method = init.method ?? 'GET'
    const record = { method, url, path: url.pathname, search: url.searchParams }
    state.requests.push(record)
    const fault = faults.find((candidate) => candidate.when(record))
    if (fault) {
      return json(fault.status, fault.body ?? {})
    }

    if (url.pathname.startsWith('/upload/')) {
      const want = url.searchParams.get('ifGenerationMatch')
      const have = state.object ? state.object.generation : '0'
      if (want !== have) {
        return json(412, {})
      }
      const generation = String(Number(have === '0' ? '1000' : have) + 1)
      state.object = { generation, body: JSON.parse(init.body) }
      return json(200, { generation })
    }
    if (method === 'DELETE') {
      if (!state.object) {
        return json(404, {})
      }
      if (url.searchParams.get('ifGenerationMatch') !== state.object.generation) {
        return json(412, {})
      }
      state.object = null
      return json(204, {})
    }
    if (!state.object) {
      return json(404, {})
    }
    if (url.searchParams.get('alt') === 'media') {
      return json(200, state.object.body)
    }
    return json(200, { generation: state.object.generation })
  }
  return { state, fetcher }
}

function json(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body
  }
}

function storedRecord({
  holderKey,
  expiresAt,
  repository = 'stablyai/orca',
  workflow = 'Deploy Relay Production'
}) {
  return {
    repository,
    workflow,
    run_id: '9001',
    run_url: 'https://github.com/stablyai/orca/actions/runs/9001',
    run_attempt: '1',
    acquired_at: NOW - 60_000,
    expires_at: expiresAt,
    holder_key: holderKey
  }
}

function leaseFor(storage, { warn = () => {} } = {}) {
  return new CloudSqlRolloutLease({
    bucket: BUCKET,
    objectName: OBJECT,
    accessToken: 'test-token',
    fetcher: storage.fetcher,
    now: () => NOW,
    warn
  })
}

const HOLDER = {
  holderKey: 'stablyai/orca-cloud/42',
  repository: 'stablyai/orca-cloud',
  workflow: 'Deploy Relay Production Same-Cap',
  runId: '42',
  runUrl: 'https://github.com/stablyai/orca-cloud/actions/runs/42',
  runAttempt: '1'
}

test('acquires a lease on an empty object with ifGenerationMatch=0', async () => {
  const storage = fakeStorage()
  const claim = await leaseFor(storage).acquire(HOLDER)

  assert.equal(claim.state, 'created')
  const upload = storage.state.requests.find((request) => request.path.startsWith('/upload/'))
  assert.equal(upload.search.get('ifGenerationMatch'), '0')
  assert.equal(upload.search.get('name'), OBJECT)
  assert.deepEqual(storage.state.object.body, {
    repository: 'stablyai/orca-cloud',
    workflow: 'Deploy Relay Production Same-Cap',
    run_id: '42',
    run_url: 'https://github.com/stablyai/orca-cloud/actions/runs/42',
    run_attempt: '1',
    acquired_at: NOW,
    expires_at: NOW + LEASE_TTL_MS,
    holder_key: 'stablyai/orca-cloud/42'
  })
})

test('refuses a live lease held by another run and never writes', async () => {
  const storage = fakeStorage({
    object: {
      generation: '1500',
      body: storedRecord({ holderKey: 'stablyai/orca/9001', expiresAt: NOW + 60_000 })
    }
  })

  const error = await leaseFor(storage)
    .acquire(HOLDER)
    .catch((thrown) => thrown)

  assert.ok(error instanceof LeaseConflict)
  assert.equal(error.holder.repository, 'stablyai/orca')
  assert.equal(error.holder.run_url, 'https://github.com/stablyai/orca/actions/runs/9001')
  assert.equal(
    storage.state.requests.filter((request) => request.method !== 'GET').length,
    0,
    'a foreign live lease must not be written'
  )
  assert.equal(storage.state.object.generation, '1500')
})

test('re-enters a live lease this run already holds and extends it', async () => {
  const storage = fakeStorage({
    object: {
      generation: '1500',
      body: storedRecord({ holderKey: HOLDER.holderKey, expiresAt: NOW + 60_000 })
    }
  })
  const warnings = []
  const claim = await leaseFor(storage, { warn: (message) => warnings.push(message) }).acquire(
    HOLDER
  )

  assert.equal(claim.state, 'reentrant')
  assert.deepEqual(warnings, [], 're-entering our own lease is not a takeover')
  assert.equal(claim.record.acquired_at, NOW - 60_000, 'original acquisition time is preserved')
  assert.equal(claim.record.expires_at, NOW + LEASE_TTL_MS)
  const upload = storage.state.requests.find((request) => request.path.startsWith('/upload/'))
  assert.equal(upload.search.get('ifGenerationMatch'), '1500')
  assert.equal(storage.state.object.generation, '1501')
})

test('takes over an expired lease and warns naming the stale holder', async () => {
  const storage = fakeStorage({
    object: {
      generation: '1500',
      body: storedRecord({
        holderKey: 'stablyai/orca/9001',
        expiresAt: NOW - 1,
        repository: 'stablyai/orca',
        workflow: 'Deploy Relay Production Capacity'
      })
    }
  })
  const warnings = []
  const claim = await leaseFor(storage, { warn: (message) => warnings.push(message) }).acquire(
    HOLDER
  )

  assert.equal(claim.state, 'takeover')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /stablyai\/orca/)
  assert.match(warnings[0], /Deploy Relay Production Capacity/)
  assert.match(warnings[0], /actions\/runs\/9001/)
  const upload = storage.state.requests.find((request) => request.path.startsWith('/upload/'))
  assert.equal(upload.search.get('ifGenerationMatch'), '1500')
  assert.equal(storage.state.object.body.holder_key, HOLDER.holderKey)
})

test('releases with a generation match and leaves the object gone', async () => {
  const storage = fakeStorage()
  const lease = leaseFor(storage)
  const claim = await lease.acquire(HOLDER)

  const released = await lease.release(HOLDER.holderKey)

  assert.deepEqual(released, { released: true, generation: claim.generation })
  const remove = storage.state.requests.find((request) => request.method === 'DELETE')
  assert.equal(remove.search.get('ifGenerationMatch'), claim.generation)
  assert.equal(storage.state.object, null)
})

test('refuses to release a lease another run now holds', async () => {
  const storage = fakeStorage({
    object: {
      generation: '1500',
      body: storedRecord({ holderKey: 'stablyai/orca/9001', expiresAt: NOW + 60_000 })
    }
  })

  const released = await leaseFor(storage).release(HOLDER.holderKey)

  assert.equal(released.released, false)
  assert.equal(released.reason, 'foreign')
  assert.equal(storage.state.object.generation, '1500')
})

test('fails closed when the bucket answers 5xx', async () => {
  const storage = fakeStorage({
    faults: [{ when: (request) => request.method === 'GET', status: 503 }]
  })

  const error = await leaseFor(storage)
    .acquire(HOLDER)
    .catch((thrown) => thrown)

  assert.match(error.message, /lease inspection failed: 503/)
  assert.equal(storage.state.requests.filter((request) => request.method !== 'GET').length, 0)
})

test('fails closed when permission is denied', async () => {
  const storage = fakeStorage({
    faults: [{ when: (request) => request.method === 'GET', status: 403 }]
  })

  const error = await leaseFor(storage)
    .acquire(HOLDER)
    .catch((thrown) => thrown)

  assert.match(error.message, /lease inspection failed: 403/)
})

test('treats an unreadable record as held, not free', async () => {
  const storage = fakeStorage({
    object: { generation: '1500', body: { holder_key: 'stablyai/orca/9001' } }
  })

  const error = await leaseFor(storage)
    .acquire(HOLDER)
    .catch((thrown) => thrown)

  assert.ok(error instanceof LeaseUnreadable)
  assert.equal(storage.state.object.generation, '1500')
})

test('reports a 412 during acquisition as a conflict', async () => {
  const storage = fakeStorage({
    faults: [{ when: (request) => request.path.startsWith('/upload/'), status: 412 }]
  })

  const error = await leaseFor(storage)
    .acquire(HOLDER)
    .catch((thrown) => thrown)

  assert.ok(error instanceof LeaseConflict)
  assert.match(error.message, /changed concurrently/)
})

test('renewal rewrites only expires_at on the observed generation', async () => {
  const storage = fakeStorage()
  const lease = leaseFor(storage)
  await lease.acquire(HOLDER)
  storage.state.object.body.expires_at = NOW - 1

  const renewed = await lease.renew(HOLDER.holderKey)

  assert.equal(renewed.renewed, true)
  assert.equal(storage.state.object.body.expires_at, NOW + LEASE_TTL_MS)
  assert.equal(storage.state.object.body.acquired_at, NOW)
  assert.equal(storage.state.object.body.holder_key, HOLDER.holderKey)
})

test('renewal stops once the object belongs to someone else', async () => {
  const storage = fakeStorage({
    object: {
      generation: '1500',
      body: storedRecord({ holderKey: 'stablyai/orca/9001', expiresAt: NOW + 60_000 })
    }
  })

  assert.deepEqual(await leaseFor(storage).renew(HOLDER.holderKey), {
    renewed: false,
    reason: 'foreign'
  })
})

test('the access token source re-mints only after the reuse window', () => {
  let clock = 0
  let mints = 0
  const source = createAccessTokenSource({
    run: () => `token-${++mints}`,
    now: () => clock
  })

  assert.equal(source(), 'token-1')
  clock = 39 * 60 * 1_000
  assert.equal(source(), 'token-1')
  clock = 41 * 60 * 1_000
  assert.equal(source(), 'token-2')
})

test('the access token source rejects an empty gcloud response', () => {
  const source = createAccessTokenSource({ run: () => '' })
  assert.throws(() => source(), /empty token/)
})
