import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CloudSqlRolloutLease, LeaseConflict, LeaseUnreadable } from './storage-lease.mjs'

const BUCKET = 'onorca-cloud-terraform-state'
const OBJECT = 'terraform/state/cloud-sql-rollout/production.lock'
const NOW = 1_756_000_000_000

function fakeStorage({ object = null } = {}) {
  const state = { object }
  const fetcher = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl)
    const method = init.method ?? 'GET'

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

function storedRecord({ holderKey, expiresAt }) {
  return {
    repository: 'stablyai/orca',
    workflow: 'Deploy Relay Production',
    run_id: '9001',
    run_url: 'https://github.com/stablyai/orca/actions/runs/9001',
    run_attempt: '1',
    acquired_at: NOW - 60_000,
    expires_at: expiresAt,
    holder_key: holderKey
  }
}

function leaseFor(storage) {
  return new CloudSqlRolloutLease({
    bucket: BUCKET,
    objectName: OBJECT,
    accessToken: 'test-token',
    fetcher: storage.fetcher,
    now: () => NOW,
    warn: () => {}
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
  assert.equal(storage.state.object.generation, '1500')
})

test('takes over an expired lease', async () => {
  const storage = fakeStorage({
    object: {
      generation: '1500',
      body: storedRecord({
        holderKey: 'stablyai/orca/9001',
        expiresAt: NOW - 1
      })
    }
  })
  await leaseFor(storage).acquire(HOLDER)

  assert.equal(storage.state.object.body.holder_key, HOLDER.holderKey)
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
