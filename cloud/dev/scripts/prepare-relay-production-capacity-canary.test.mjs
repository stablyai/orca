import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseProductionCapacityCellArguments,
  prepareProductionCapacityCell,
  PRODUCTION_CAPACITY_CELL_IDS
} from './prepare-relay-production-capacity-canary.mjs'

const config = {
  directorOrigin: 'https://relay.onorca.dev',
  cellOrigin: 'https://c26.relay.onorca.dev',
  cellId: 'production-gce-c26'
}

const membership = {
  existingOnly: ['production-gce-c1'],
  migrationOnly: ['production-gce-c17'],
  general: ['production-gce-c25', 'production-gce-c26']
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function canaryFetch() {
  let selector = { generation: 20, attemptId: null, membership }
  const calls = []
  const fetch = async (url, init) => {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body)
    calls.push({ path, body })
    if (path === '/v1/admin/admission-selector/status') {
      return response({
        v: 1,
        selector,
        intent: body.attemptId
          ? {
              attemptId: body.attemptId,
              state: 'committed',
              expectedGeneration: selector.generation - 1,
              intendedGeneration: selector.generation,
              membership: selector.membership
            }
          : null
      })
    }
    if (path === '/v1/admin/admission-selector/apply') {
      selector = {
        generation: selector.generation + 1,
        attemptId: body.attemptId,
        membership: body.membership
      }
      return response({ v: 1, changed: true, selector })
    }
    if (path === '/v1/admin/drain') return response({ v: 1, draining: true })
    throw new Error(`unexpected ${path}`)
  }
  return { calls, fetch, selector: () => selector }
}

describe('production Relay capacity cell admission', () => {
  it('allows only the serving rollout cells', () => {
    assert.deepEqual(PRODUCTION_CAPACITY_CELL_IDS, [
      'production-gce-c7',
      'production-gce-c8',
      'production-gce-c9',
      'production-gce-c10',
      'production-gce-c13',
      'production-gce-c14',
      'production-gce-c15',
      'production-gce-c16',
      'production-gce-c19',
      'production-gce-c20',
      'production-gce-c21',
      'production-gce-c22',
      'production-gce-c23',
      'production-gce-c24',
      'production-gce-c25',
      'production-gce-c26'
    ])
    assert.deepEqual(parseProductionCapacityCellArguments([
      '--director-origin', 'https://relay.onorca.dev',
      '--cell-origin', 'https://c7.relay.onorca.dev',
      '--cell-id', 'production-gce-c7',
      '--mode', 'isolate'
    ]), {
      directorOrigin: 'https://relay.onorca.dev',
      cellOrigin: 'https://c7.relay.onorca.dev',
      cellId: 'production-gce-c7',
      mode: 'isolate'
    })
    assert.throws(() => parseProductionCapacityCellArguments([
      '--director-origin', 'https://relay.onorca.dev',
      '--cell-origin', 'https://c17.relay.onorca.dev',
      '--cell-id', 'production-gce-c17',
      '--mode', 'isolate'
    ]), /not approved/)
    assert.throws(() => parseProductionCapacityCellArguments([
      '--director-origin', 'https://relay.onorca.dev',
      '--cell-origin', 'https://c8.relay.onorca.dev',
      '--cell-id', 'production-gce-c7',
      '--mode', 'isolate'
    ]), /origin is not exact/)
  })

  it('isolates only the selected cell without depending on its runtime', async () => {
    const fake = canaryFetch()
    const result = await prepareProductionCapacityCell(
      { ...config, mode: 'isolate' },
      { fetch: fake.fetch, token: 'token' }
    )
    assert.equal(result.admissionState, 'migration-only')
    assert.deepEqual(fake.selector().membership, {
      existingOnly: ['production-gce-c1'],
      migrationOnly: ['production-gce-c17', 'production-gce-c26'],
      general: ['production-gce-c25']
    })
    assert.doesNotMatch(fake.calls.map(({ path }) => path).join(','), /\/v1\/admin\/drain/)
  })

  it('drains the selected cell independently after durable isolation', async () => {
    const fake = canaryFetch()
    const result = await prepareProductionCapacityCell(
      { ...config, mode: 'drain' },
      { fetch: fake.fetch, token: 'token' }
    )
    assert.deepEqual(result, { changed: false, drained: true })
    assert.deepEqual(fake.calls, [{
      path: '/v1/admin/drain',
      body: { v: 1, graceMs: 0 }
    }])
  })

  it('restores only the selected cell to general admission', async () => {
    const fake = canaryFetch()
    await prepareProductionCapacityCell(
      { ...config, mode: 'isolate' },
      { fetch: fake.fetch, token: 'token' }
    )
    const result = await prepareProductionCapacityCell(
      { ...config, mode: 'activate' },
      { fetch: fake.fetch, token: 'token' }
    )
    assert.equal(result.admissionState, 'general')
    assert.deepEqual(fake.selector().membership, membership)
  })

  it('refuses an irreversible existing-only target', async () => {
    const fetch = async () => response({
      v: 1,
      selector: {
        generation: 20,
        attemptId: null,
        membership: {
          existingOnly: ['production-gce-c26'],
          migrationOnly: ['production-gce-c17'],
          general: ['production-gce-c25']
        }
      },
      intent: null
    })
    await assert.rejects(
      prepareProductionCapacityCell(
        { ...config, mode: 'isolate' },
        { fetch, token: 'token' }
      ),
      /irreversible/
    )
  })
})
