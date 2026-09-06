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

const sleepingStagingGcloud: GcloudClient = { accessToken: async () => 'a'.repeat(40) }

// Staging's Cloud SQL is stopped, so this inventory reads REST only and probes no endpoint.
type MigOutcome = 'ok' | 'throw' | 'missing'
const sleepingStagingFetch = (migOutcome: (migName: string) => MigOutcome): typeof fetch =>
  async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'run.googleapis.com') return Response.json(runService)
    if (url.hostname === 'sqladmin.googleapis.com') return Response.json({
      state: 'STOPPED',
      databaseVersion: 'POSTGRES_17',
      settings: { activationPolicy: 'NEVER', availabilityType: 'ZONAL', tier: 'db-custom-1-3840' }
    })
    if (url.hostname === 'certificatemanager.googleapis.com') return Response.json({
      managed: { domains: ['*.relay-staging.onorca.dev'], state: 'ACTIVE' }
    })
    if (url.pathname.includes('/instanceGroupManagers/')) {
      const name = url.pathname.split('/').at(-1)!
      const outcome = migOutcome(name)
      if (outcome === 'throw') throw new TypeError('fetch failed')
      if (outcome === 'missing') return new Response(null, { status: 404 })
      return Response.json({
        name,
        targetSize: 0,
        size: '0',
        instanceGroup: `projects/project/zones/zone/instanceGroups/${name}`,
        instanceTemplate: `projects/project/global/instanceTemplates/template-${name}`,
        status: { isStable: true }
      })
    }
    if (url.pathname.includes('/instanceTemplates/')) return Response.json({ properties: {} })
    if (url.pathname.endsWith('/getHealth')) return Response.json([])
    throw new Error(`Unexpected request to ${url.hostname}${url.pathname}`)
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
      {
        wait: async () => {
          waits += 1
        }
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
      {
        wait: async (ms) => {
          waits.push(ms)
        }
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
      {
        wait: async (ms) => {
          waits.push(ms)
        }
      }
    )

    expect(result.health).toBe(false)
    expect(result.ready).toBe(false)
    expect(calls).toBe(4)
    // A refusing endpoint is a reading, so only the independent retry runs.
    expect(waits).toEqual([11_000])
  })

  it('treats a thrown fetch as no reading and re-asks that path once', async () => {
    const calls: string[] = []
    const waits: number[] = []
    const result = await probeEndpointHealth(
      'https://c9.relay.onorca.dev',
      async (input) => {
        const path = new URL(String(input)).pathname
        calls.push(path)
        if (path === '/health' && calls.filter((call) => call === '/health').length === 1) {
          throw new TypeError('fetch failed')
        }
        return new Response(null, { status: 200 })
      },
      {
        wait: async (ms) => {
          waits.push(ms)
        }
      }
    )

    expect(result.health).toBe(true)
    expect(result.ready).toBe(true)
    expect(calls.filter((call) => call === '/health')).toEqual(['/health', '/health'])
    expect(waits).toEqual([1_000])
  })

  it('fails closed when both attempts of a path throw', async () => {
    const calls: string[] = []
    const waits: number[] = []
    const result = await probeEndpointHealth(
      'https://c9.relay.onorca.dev',
      async (input) => {
        const path = new URL(String(input)).pathname
        calls.push(path)
        if (path === '/health') throw new TypeError('fetch failed')
        return new Response(null, { status: 200 })
      },
      {
        wait: async (ms) => {
          waits.push(ms)
        }
      }
    )

    expect(result.health).toBe(false)
    expect(calls.filter((call) => call === '/health')).toHaveLength(4)
    expect(waits).toEqual([1_000, 11_000, 1_000])
  })

  it('accepts an auth-shaped endpoint that serves no readiness path', async () => {
    const calls: string[] = []
    const waits: number[] = []
    const result = await probeEndpointHealth(
      'https://login.onorca.dev',
      async (input) => {
        const path = new URL(String(input)).pathname
        calls.push(path)
        return new Response(null, { status: path === '/ready' ? 404 : 200 })
      },
      {
        requiresReady: false,
        wait: async (ms) => {
          waits.push(ms)
        }
      }
    )

    expect(result.health).toBe(true)
    expect(result.ready).toBeNull()
    expect(calls).toEqual(['/health'])
    expect(waits).toEqual([])
  })

  it('still requires readiness for the director and cells', async () => {
    const waits: number[] = []
    const result = await probeEndpointHealth(
      'https://relay.onorca.dev',
      async (input) => new Response(null, {
        status: new URL(String(input)).pathname === '/ready' ? 503 : 200
      }),
      {
        wait: async (ms) => {
          waits.push(ms)
        }
      }
    )

    expect(result.health).toBe(true)
    expect(result.ready).toBe(false)
    expect(waits).toEqual([11_000])
  })

  it('measures latency as the answering round trip, not the retry delay', async () => {
    let healthCalls = 0
    const result = await probeEndpointHealth(
      'https://c9.relay.onorca.dev',
      async (input) => {
        if (new URL(String(input)).pathname !== '/health') return new Response(null, { status: 200 })
        healthCalls += 1
        if (healthCalls === 1) throw new TypeError('fetch failed')
        return new Response(null, { status: 200 })
      },
      { wait: async (ms) => await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 60))) }
    )

    expect(result.health).toBe(true)
    expect(result.latencyMs).not.toBeNull()
    expect(result.latencyMs!).toBeLessThan(60)
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

  it('re-asks a MIG read that failed once before calling a cell powered-unknown', async () => {
    const parkedCell = RELAY_OPS_ENVIRONMENTS.staging.cells[0]!
    const waits: number[] = []
    let parkedMigCalls = 0
    const result = await readResourceInventory(
      RELAY_OPS_ENVIRONMENTS.staging,
      sleepingStagingGcloud,
      sleepingStagingFetch((migName) => {
        if (!migName.endsWith(parkedCell.hostname)) return 'ok'
        parkedMigCalls += 1
        return parkedMigCalls === 1 ? 'throw' : 'ok'
      }),
      { wait: async (ms) => { waits.push(ms) } }
    )

    const parked = result.cells.find((cell) => cell.cellId === parkedCell.cellId)!
    // The MIG was fine and parked at zero; one transient read must not erase that reading.
    expect(parked.targetSize).toBe(0)
    expect(parkedMigCalls).toBe(2)
    expect(waits).toEqual([1_000])
    expect(result.warnings).toEqual([])
  })

  it('reports a MIG unavailable only when the retry fails too', async () => {
    const parkedCell = RELAY_OPS_ENVIRONMENTS.staging.cells[0]!
    const waits: number[] = []
    let parkedMigCalls = 0
    const result = await readResourceInventory(
      RELAY_OPS_ENVIRONMENTS.staging,
      sleepingStagingGcloud,
      sleepingStagingFetch((migName) => {
        if (!migName.endsWith(parkedCell.hostname)) return 'ok'
        parkedMigCalls += 1
        return 'throw'
      }),
      { wait: async (ms) => { waits.push(ms) } }
    )

    const parked = result.cells.find((cell) => cell.cellId === parkedCell.cellId)!
    expect(parked.targetSize).toBeNull()
    expect(parked.backendHealth).toBe('unknown')
    expect(parkedMigCalls).toBe(2)
    expect(waits).toEqual([1_000])
    expect(result.warnings).toEqual([
      `${parkedCell.hostname.toUpperCase()} MIG inventory is unavailable.`
    ])
  })

  it('does not re-ask a MIG read the API answered with 404', async () => {
    const missingCell = RELAY_OPS_ENVIRONMENTS.staging.cells[0]!
    const waits: number[] = []
    let missingMigCalls = 0
    const result = await readResourceInventory(
      RELAY_OPS_ENVIRONMENTS.staging,
      sleepingStagingGcloud,
      sleepingStagingFetch((migName) => {
        if (!migName.endsWith(missingCell.hostname)) return 'ok'
        missingMigCalls += 1
        return 'missing'
      }),
      { wait: async (ms) => { waits.push(ms) } }
    )

    expect(result.cells.find((cell) => cell.cellId === missingCell.cellId)!.targetSize).toBeNull()
    expect(missingMigCalls).toBe(1)
    expect(waits).toEqual([])
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
