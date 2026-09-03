import { describe, expect, it } from 'vitest'
import { RELAY_OPS_ENVIRONMENTS } from './environment-config.js'
import type { GcloudClient } from './gcloud-client.js'
import { probeEndpointHealth, readResourceInventory } from './resource-inventory.js'

const digest = `sha256:${'a'.repeat(64)}`
const runService = {
  template: {
    scaling: { minInstanceCount: 0, maxInstanceCount: 2 },
    containers: [{ image: 'registry/image:tag' }]
  },
  conditions: [{ state: 'CONDITION_SUCCEEDED' }],
  latestReadyRevision: 'projects/project/revisions/revision-one'
}

describe('readResourceInventory', () => {
  it('does not delay a healthy endpoint sample', async () => {
    let calls = 0
    let waits = 0
    const result = await probeEndpointHealth(
      'https://c9.relay.onorca.dev',
      async () => {
        calls += 1
        return new Response(null, { status: 200 })
      },
      async () => {
        waits += 1
      }
    )

    expect(result.health).toBe(true)
    expect(result.ready).toBe(true)
    expect(calls).toBe(2)
    expect(waits).toBe(0)
  })

  it('retries one transient endpoint failure within the same sample', async () => {
    const calls = new Map<string, number>()
    const waits: number[] = []
    const result = await probeEndpointHealth(
      'https://c9.relay.onorca.dev',
      async (input) => {
        const path = new URL(String(input)).pathname
        const call = (calls.get(path) ?? 0) + 1
        calls.set(path, call)
        return new Response(null, { status: path === '/ready' && call === 1 ? 503 : 200 })
      },
      async (ms) => {
        waits.push(ms)
      }
    )

    expect(result.health).toBe(true)
    expect(result.ready).toBe(true)
    expect(calls).toEqual(new Map([['/health', 2], ['/ready', 2]]))
    expect(waits).toEqual([11_000])
  })

  it('fails closed when the endpoint retry is also unhealthy', async () => {
    let calls = 0
    const waits: number[] = []
    const result = await probeEndpointHealth(
      'https://c9.relay.onorca.dev',
      async () => {
        calls += 1
        return new Response(null, { status: 503 })
      },
      async (ms) => {
        waits.push(ms)
      }
    )

    expect(result.health).toBe(false)
    expect(result.ready).toBe(false)
    expect(calls).toBe(4)
    expect(waits).toEqual([11_000])
  })

  it('uses aggregate REST inventory without probing sleeping staging endpoints', async () => {
    const gcloud: GcloudClient = { accessToken: async () => 'a'.repeat(40) }
    let publicProbeCalls = 0
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input))
      if (url.hostname.endsWith('onorca.dev')) {
        publicProbeCalls += 1
        return Response.json({ status: 'ok' })
      }
      if (url.hostname === 'run.googleapis.com') return Response.json(runService)
      if (url.hostname === 'sqladmin.googleapis.com') return Response.json({
        state: 'STOPPED',
        databaseVersion: 'POSTGRES_17',
        settings: {
          activationPolicy: 'NEVER',
          availabilityType: 'ZONAL',
          tier: 'db-custom-1-3840'
        }
      })
      if (url.hostname === 'certificatemanager.googleapis.com') return Response.json({
        managed: { domains: ['*.relay-staging.onorca.dev'], state: 'ACTIVE' }
      })
      if (url.pathname.includes('/instanceGroupManagers/')) {
        const name = url.pathname.split('/').at(-1)!
        return Response.json({
          name,
          targetSize: 0,
          size: '0',
          instanceGroup: `projects/project/zones/zone/instanceGroups/${name}`,
          instanceTemplate: `projects/project/global/instanceTemplates/template-${name}`,
          status: { isStable: true }
        })
      }
      if (url.pathname.includes('/instanceTemplates/')) return Response.json({
        properties: { metadata: { items: [{
          key: 'startup-script',
          value: `SECRET_TEXT\nORCA_RELAY_IMAGE_DIGEST=%s\\n' '${digest}'`
        }] } }
      })
      if (url.pathname.endsWith('/getHealth')) return Response.json([])
      throw new Error(`Unexpected request to ${url.hostname}${url.pathname}`)
    }

    const result = await readResourceInventory(
      RELAY_OPS_ENVIRONMENTS.staging,
      gcloud,
      fetchImpl
    )

    expect(publicProbeCalls).toBe(0)
    expect(result.cells.every((cell) => cell.targetSize === 0)).toBe(true)
    expect(result.cells.every((cell) => cell.endpoint.health === null)).toBe(true)
    expect(result.cells.every((cell) => cell.imageDigest === digest)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('SECRET_TEXT')
  })

  it('represents missing credentials as unknown inventory, never sleeping', async () => {
    const gcloud: GcloudClient = {
      accessToken: async () => { throw new Error('sensitive context') }
    }
    let fetchCalls = 0
    const result = await readResourceInventory(
      RELAY_OPS_ENVIRONMENTS.production,
      gcloud,
      async () => { fetchCalls += 1; return Response.json({}) }
    )
    expect(fetchCalls).toBe(0)
    expect(result.cells.every((cell) => cell.targetSize === null)).toBe(true)
    expect(result.cells.every((cell) => cell.backendHealth === 'unknown')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sensitive context')
  })
})
