import { describe, expect, it } from 'vitest'
import { buildCostModel } from './cost-model.js'
import {
  RELAY_OPS_ENVIRONMENTS,
  relayOpsCellsFromTerraform,
  type RelayOpsCellConfig
} from './environment-config.js'
import type { ResourceInventory } from './resource-inventory.js'

const regionalCellsSource = `
relay_gce_cells = {
  "staging-gce-c3" = {
    hostname          = "c3"
    zone              = "us-central1-a"
    machine_type      = "e2-standard-2"
    capacity_requests = 4000
  }
  "staging-gce-c4" = {
    hostname           = "c4"
    region             = "asia-east2"
    zone               = "asia-east2-a"
    machine_type       = "e2-standard-4"
    capacity_requests  = 6000
    database_pool_max  = 10
    initially_enabled  = false
  }
}
`

function inventory(
  targetSize: number,
  activationPolicy: string,
  cells: RelayOpsCellConfig[] = RELAY_OPS_ENVIRONMENTS.staging.cells
): ResourceInventory {
  return {
    director: null,
    auth: null,
    sql: { state: targetSize ? 'RUNNABLE' : 'STOPPED', activationPolicy, tier: 'db-custom-1-3840', availabilityType: 'ZONAL', databaseVersion: 'POSTGRES_17' },
    certificate: null,
    directorEndpoint: { health: null, ready: null, latencyMs: null },
    authEndpoint: { health: null, ready: null, latencyMs: null },
    cells: cells.map((cell) => ({
      ...cell, migName: `mig-${cell.hostname}`, targetSize, runningInstances: targetSize,
      stable: true, template: 'template', imageDigest: null,
      backendHealth: targetSize ? 'healthy' : 'empty',
      endpoint: { health: null, ready: null, latencyMs: null }
    })),
    warnings: []
  }
}

describe('buildCostModel', () => {
  it('shows the sleeping staging floor without VM or SQL compute', () => {
    const result = buildCostModel(RELAY_OPS_ENVIRONMENTS.staging, inventory(0, 'NEVER'))
    expect(result.kind).toBe('planning-estimate')
    expect(result.monthlyUsd).toBe(34)
    expect(result.lines.find((line) => line.label === 'Relay cell VMs')?.monthlyUsd).toBe(0)
    expect(result.actualBilling.available).toBe(false)
    expect(result.caveats[0]).toContain('not the Cloud Billing invoice')
  })

  it('prices durable machine inventory and network floors by region', () => {
    const cells = relayOpsCellsFromTerraform({
      environment: 'staging',
      domain: 'relay-staging.onorca.dev',
      source: regionalCellsSource
    })
    const environment = { ...RELAY_OPS_ENVIRONMENTS.staging, cells }
    const result = buildCostModel(environment, inventory(1, 'NEVER', cells))
    const machines = result.lines.find((line) => line.label === 'Relay cell VMs')
    const network = result.lines.find((line) => line.label === 'Load balancer and network floor')

    expect(machines).toEqual({
      label: 'Relay cell VMs',
      monthlyUsd: 185.79,
      basis: '2 configured VM cells at regional machine rates × 730 hours'
    })

    expect(network).toEqual({
      label: 'Load balancer and network floor',
      monthlyUsd: 29,
      basis: 'shared HTTPS foundation plus NAT floor in 2 configured regions'
    })
  })
})
