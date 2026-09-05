import assert from 'node:assert/strict'
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
