import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  parseRehomeTrustProbeArguments,
  probeRehomeTrust
} from './probe-relay-rehome-trust.mjs'

const argv = [
  '--director-origin', 'https://relay.onorca.dev',
  '--cell-id', 'production-gce-c7',
  '--cell-incarnation', '11111111-1111-4111-8111-111111111111'
]
const environment = { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' }

test('binds the application-mediated probe to an exact approved cell incarnation', () => {
  assert.equal(parseRehomeTrustProbeArguments(argv, environment).cellId, 'production-gce-c7')
  assert.throws(() => parseRehomeTrustProbeArguments(
    argv.with(1, 'https://other.example.test'),
    environment
  ))
  assert.throws(() => parseRehomeTrustProbeArguments(argv, {
    ORCA_RELAY_ADMIN_ID_TOKEN: 'not-a-token'
  }))
})

test('requires complete aggregate application-mediated trust proof', async () => {
  const config = parseRehomeTrustProbeArguments(argv, environment)
  const result = await probeRehomeTrust(config, {
    fetch: async (url, init) => {
      assert.equal(url, 'https://relay.onorca.dev/v1/admin/regional-rehome-trust-probe')
      assert.deepEqual(JSON.parse(init.body), {
        v: 1,
        sourceCellId: 'production-gce-c7',
        sourceCellIncarnation: '11111111-1111-4111-8111-111111111111'
      })
      return Response.json({
        v: 1,
        dedicatedIdentity: {
          firstOutcome: 'host-not-connected',
          secondOutcome: 'host-not-connected',
          accepted: true,
          idempotent: true
        },
        sharedRuntimeIdentityRejected: true,
        proven: true
      })
    }
  })
  assert.equal(result.proven, true)
})

test('rejects partial or mismatched proof', async () => {
  const config = parseRehomeTrustProbeArguments(argv, environment)
  await assert.rejects(
    probeRehomeTrust(config, {
      fetch: async () => Response.json({
        v: 1,
        dedicatedIdentity: {
          firstOutcome: 'host-not-connected',
          secondOutcome: 'host-not-connected',
          accepted: true,
          idempotent: true
        },
        sharedRuntimeIdentityRejected: false,
        proven: false
      })
    }),
    /incomplete/
  )
})

const provenProbe = {
  v: 1,
  dedicatedIdentity: {
    firstOutcome: 'host-not-connected',
    secondOutcome: 'host-not-connected',
    accepted: true,
    idempotent: true
  },
  sharedRuntimeIdentityRejected: true,
  proven: true
}

test('retries a transient 503 on the trust probe and proves on the second answer', async () => {
  const config = parseRehomeTrustProbeArguments(argv, environment)
  let calls = 0
  const result = await probeRehomeTrust(config, {
    wait: async () => {},
    fetch: async () => {
      calls += 1
      if (calls === 1) return new Response('warming up', { status: 503 })
      return Response.json(provenProbe)
    }
  })
  assert.equal(calls, 2)
  assert.equal(result.proven, true)
})

test('fails when both trust-probe attempts return a transient 503', async () => {
  const config = parseRehomeTrustProbeArguments(argv, environment)
  let calls = 0
  await assert.rejects(
    probeRehomeTrust(config, {
      wait: async () => {},
      fetch: async () => {
        calls += 1
        return new Response('warming up', { status: 503 })
      }
    }),
    /returned 503/
  )
  assert.equal(calls, 2)
})

test('approves the asia-east2 and US 3,000 rehome sources and still rejects unlisted cells', () => {
  for (const cellId of [
    'production-gce-c27', 'production-gce-c28', 'production-gce-c29', 'production-gce-c30',
    'production-gce-c31', 'production-gce-c32', 'production-gce-c33', 'production-gce-c34'
  ]) {
    const parsed = parseRehomeTrustProbeArguments(
      argv.map((value) => (value === 'production-gce-c7' ? cellId : value)),
      environment
    )
    assert.equal(parsed.cellId, cellId)
  }
  for (const cellId of ['production-gce-c1', 'production-gce-c17', 'production-gce-c35']) {
    assert.throws(
      () =>
        parseRehomeTrustProbeArguments(
          argv.map((value) => (value === 'production-gce-c7' ? cellId : value)),
          environment
        ),
      /--cell-id is not approved/
    )
  }
})

test('retries one director-wrapped source 503 without relaxing the proof', async () => {
  let calls = 0
  const result = await probeRehomeTrust(parseRehomeTrustProbeArguments(argv, environment), {
    wait: async () => {},
    fetch: async () => ++calls === 1
      ? Response.json({ error: 'regional_rehome_trust_probe_source_503' }, { status: 409 })
      : Response.json(provenProbe)
  })
  assert.equal(calls, 2)
  assert.equal(result.proven, true)
})

test('reports safe trust reasons, keeps rejection final, and redacts arbitrary error text', async () => {
  for (const reason of ['regional_rehome_trust_probe_source_403', 'secret-token-example']) {
    let calls = 0
    await assert.rejects(probeRehomeTrust(parseRehomeTrustProbeArguments(argv, environment), {
      wait: async () => { throw new Error('must not retry') },
      fetch: async () => { calls++; return Response.json({ error: reason }, { status: 409 }) }
    }), error => {
      assert.match(error.message, /returned 409/)
      assert.ok(!error.message.includes('secret-token-example'))
      if (reason.endsWith('_403')) assert.match(error.message, /source_403/)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('stops after the second wrapped transient failure', async () => {
  let calls = 0
  await assert.rejects(probeRehomeTrust(parseRehomeTrustProbeArguments(argv, environment), {
    wait: async () => {},
    fetch: async () => { calls++; return Response.json({ error: 'regional_rehome_trust_probe_source_503' }, { status: 409 }) }
  }), /returned 409.*source_503/)
  assert.equal(calls, 2)
})

// The probe allowlist is the committed rehome source list, so a declared source can always probe.
test('approves exactly the committed production rehome source cells', () => {
  const tfvars = readFileSync(
    new URL('../../infra/terraform/environments/production.tfvars', import.meta.url),
    'utf8'
  )
  const start = tfvars.indexOf('relay_region_rehome_source_cell_ids = [')
  const sources = new Set(
    [...tfvars.slice(start, tfvars.indexOf(']', start)).matchAll(/"([^"]+)"/g)].map(([, cell]) => cell)
  )
  assert.ok(sources.has('production-gce-c34'))
  for (let ordinal = 1; ordinal <= 40; ordinal++) {
    const cellId = `production-gce-c${ordinal}`
    const approved = (() => {
      try {
        parseRehomeTrustProbeArguments(
          argv.map((value) => (value === 'production-gce-c7' ? cellId : value)),
          environment
        )
        return true
      } catch {
        return false
      }
    })()
    assert.equal(approved, sources.has(cellId), cellId)
  }
})
