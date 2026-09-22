import type {
  RelayOpsEnvironment,
  RelayOpsMachineType,
  RelayOpsRegion
} from './environment-config.js'
import type { ResourceInventory } from './resource-inventory.js'

export type CostLine = {
  label: string
  monthlyUsd: number
  basis: string
}

export type CostModel = {
  kind: 'planning-estimate'
  monthlyUsd: number
  rangeUsd: [number, number]
  actualBilling: { available: false; reason: string }
  lines: CostLine[]
  caveats: string[]
}

const HOURS_PER_MONTH = 730
const MACHINE_HOURLY_USD: Record<
  RelayOpsRegion,
  Record<RelayOpsMachineType, number>
> = {
  'us-central1': {
    'e2-standard-2': 0.06701142,
    'e2-standard-4': 0.13402284
  },
  'asia-east2': {
    'e2-standard-2': 0.0938,
    'e2-standard-4': 0.1875
  }
}
const SHARED_NETWORK_FLOOR_USD = 19
const REGIONAL_NAT_FLOOR_USD = 5

function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function buildCostModel(
  environment: RelayOpsEnvironment,
  resources: ResourceInventory
): CostModel {
  const runningCells = resources.cells.filter((cell) => (cell.targetSize ?? 0) > 0)
  const runningCellCount = runningCells.reduce((sum, cell) => sum + (cell.targetSize ?? 0), 0)
  const compute = runningCells.reduce(
    (sum, cell) =>
      sum + (cell.targetSize ?? 0) * MACHINE_HOURLY_USD[cell.region][cell.machineType],
    0
  ) * HOURS_PER_MONTH
  const disks = runningCellCount * 30 * 0.1
  const sqlRunning = resources.sql?.activationPolicy === 'ALWAYS'
  const sql = sqlRunning ? (environment.id === 'production' ? 105 : 52) : 0
  const cloudRunMinimums =
    (resources.director?.minInstances ?? 0) + (resources.auth?.minInstances ?? 0)
  const cloudRun = cloudRunMinimums * 10
  const configuredRegions = new Set(
    (resources.cells.length > 0 ? resources.cells : environment.cells).map((cell) => cell.region)
  )
  const networkFoundation =
    SHARED_NETWORK_FLOOR_USD + configuredRegions.size * REGIONAL_NAT_FLOOR_USD
  const observability = environment.id === 'production' ? 12 : 5
  const lines: CostLine[] = [
    {
      label: 'Relay cell VMs',
      monthlyUsd: round(compute),
      basis: `${runningCellCount} configured VM cells at regional machine rates × 730 hours`
    },
    {
      label: 'Cell boot disks',
      monthlyUsd: round(disks),
      basis: `${runningCellCount} × 30 GB balanced persistent disk`
    },
    {
      label: 'Cloud SQL',
      monthlyUsd: sql,
      basis: sqlRunning ? `${resources.sql?.tier ?? 'configured tier'} active` : 'stopped'
    },
    {
      label: 'Cloud Run minimums',
      monthlyUsd: cloudRun,
      basis: `${cloudRunMinimums} configured minimum instances`
    },
    {
      label: 'Load balancer and network floor',
      monthlyUsd: networkFoundation,
      basis: `shared HTTPS foundation plus NAT floor in ${configuredRegions.size} configured region${configuredRegions.size === 1 ? '' : 's'}`
    },
    {
      label: 'Logs and monitoring allowance',
      monthlyUsd: observability,
      basis: 'planning allowance; varies with traffic and retention'
    }
  ]
  const monthlyUsd = round(lines.reduce((sum, line) => sum + line.monthlyUsd, 0))
  return {
    kind: 'planning-estimate',
    monthlyUsd,
    rangeUsd: [round(monthlyUsd * 0.85), round(monthlyUsd * 1.3)],
    actualBilling: {
      available: false,
      reason: 'Cloud Billing export is not configured in either Relay project.'
    },
    lines,
    caveats: [
      'This is a modeled run-rate, not the Cloud Billing invoice.',
      'Network egress, actual request traffic, credits, discounts, taxes, and free tiers are excluded.',
      'Use the GCP Billing report for authoritative spend and forecasts.'
    ]
  }
}
