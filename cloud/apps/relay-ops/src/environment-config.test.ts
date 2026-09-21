import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RELAY_OPS_ENVIRONMENTS,
  relayOpsCellsFromTerraform
} from './environment-config.js'

const durableUsCell = `
  "production-gce-c26" = {
    hostname          = "c26"
    zone              = "us-central1-a"
    machine_type      = "e2-standard-4"
    capacity_requests = 4000
    initially_enabled = false
  }
`

const durableAsiaCells = `
  "production-gce-c27" = {
    hostname           = "c27"
    region             = "asia-east2"
    zone               = "asia-east2-a"
    machine_type       = "e2-standard-4"
    capacity_requests  = 6000
    database_pool_max  = 10
    initially_enabled  = false
  }
  "production-gce-c28" = {
    hostname           = "c28"
    region             = "asia-east2"
    zone               = "asia-east2-b"
    machine_type       = "e2-standard-4"
    capacity_requests  = 6000
    database_pool_max  = 10
    initially_enabled  = false
  }
  "production-gce-c29" = {
    hostname           = "c29"
    region             = "asia-east2"
    zone               = "asia-east2-c"
    machine_type       = "e2-standard-4"
    capacity_requests  = 6000
    database_pool_max  = 10
    initially_enabled  = false
  }
`

const durableAsiaSource = `
relay_gce_cells = {${durableUsCell}${durableAsiaCells}}
`

const durableUsOnlySource = `
relay_gce_cells = {${durableUsCell}}
`

// Why: relay-ops sat at 18 cells for four days after C19-C22 shipped, which threw
// `selector membership must contain every configured cell exactly once` and blocked
// every production mutation. Reading Terraform here makes that drift fail the build.
function terraformCells(environment: 'production' | 'staging'): Array<{
  cellId: string
  region: string
  zone: string
  machineType: string
  capacityRequests: number
  databasePoolMax: number
}> {
  const tfvars = readFileSync(
    fileURLToPath(new URL(`../../../infra/terraform/environments/${environment}.tfvars`, import.meta.url)),
    'utf8'
  )
  const block = /relay_gce_cells\s*=\s*\{([\s\S]*)\n\}/.exec(tfvars)?.[1] ?? ''
  return [...block.matchAll(/"([a-z]+-gce-c\d+)"\s*=\s*\{([\s\S]*?)\n {2}\}/g)]
    .map((match) => ({
      cellId: match[1] ?? '',
      region: /region\s*=\s*"([^"]+)"/.exec(match[2] ?? '')?.[1] ?? 'us-central1',
      zone: /zone\s*=\s*"([^"]+)"/.exec(match[2] ?? '')?.[1] ?? '',
      machineType: /machine_type\s*=\s*"([^"]+)"/.exec(match[2] ?? '')?.[1] ?? '',
      capacityRequests: Number(/capacity_requests\s*=\s*(\d+)/.exec(match[2] ?? '')?.[1]),
      databasePoolMax: Number(/database_pool_max\s*=\s*(\d+)/.exec(match[2] ?? '')?.[1] ?? 10)
    }))
    .sort((left, right) => cellOrdinal(left.cellId) - cellOrdinal(right.cellId))
}

const cellOrdinal = (cellId: string): number => Number(/c(\d+)$/.exec(cellId)?.[1] ?? 0)

describe('relay operations environment config', () => {
  it.each(['production', 'staging'] as const)(
    'matches the %s cells Terraform actually provisions',
    (environment) => {
      const expected = terraformCells(environment)
      expect(expected.length).toBeGreaterThan(0)
      expect(
        RELAY_OPS_ENVIRONMENTS[environment].cells.map((cell) => ({
          cellId: cell.cellId,
          region: cell.region,
          zone: cell.zone,
          machineType: cell.machineType,
          capacityRequests: cell.capacityRequests,
          databasePoolMax: cell.databasePoolMax
        }))
      ).toEqual(expected)
    }
  )

  it('derives hostname and origin from the cell ordinal', () => {
    const cells = RELAY_OPS_ENVIRONMENTS.production.cells
    expect(cells.at(-1)).toMatchObject({
      hostname: `c${cells.length}`,
      origin: `https://c${cells.length}.relay.onorca.dev`
    })
  })

  it('inventories Asia cells only when they exist in durable Terraform', () => {
    const cells = relayOpsCellsFromTerraform({
      environment: 'production',
      domain: 'relay.onorca.dev',
      source: durableAsiaSource
    })

    expect(cells.slice(1)).toEqual([
      {
        cellId: 'production-gce-c27', hostname: 'c27', origin: 'https://c27.relay.onorca.dev',
        region: 'asia-east2', zone: 'asia-east2-a', machineType: 'e2-standard-4',
        capacityRequests: 6000, databasePoolMax: 10, configuredAdmission: false
      },
      {
        cellId: 'production-gce-c28', hostname: 'c28', origin: 'https://c28.relay.onorca.dev',
        region: 'asia-east2', zone: 'asia-east2-b', machineType: 'e2-standard-4',
        capacityRequests: 6000, databasePoolMax: 10, configuredAdmission: false
      },
      {
        cellId: 'production-gce-c29', hostname: 'c29', origin: 'https://c29.relay.onorca.dev',
        region: 'asia-east2', zone: 'asia-east2-c', machineType: 'e2-standard-4',
        capacityRequests: 6000, databasePoolMax: 10, configuredAdmission: false
      }
    ])

    const usOnlyCells = relayOpsCellsFromTerraform({
      environment: 'production',
      domain: 'relay.onorca.dev',
      source: durableUsOnlySource
    })
    expect(usOnlyCells).toHaveLength(1)
    expect(usOnlyCells.some((cell) => cell.region === 'asia-east2')).toBe(false)
    expect(usOnlyCells.some((cell) => cell.cellId === 'production-gce-c27')).toBe(false)
  })
})
