import type { RelayOpsEnvironmentId } from './environment-config.js'
import { relayOpsEnvironment } from './environment-config.js'
import type { GcloudClient } from './gcloud-client.js'
import { readRelayWorkflowRuns } from './github-runs.js'
import { readMonitoringSnapshot } from './monitoring-snapshot.js'
import { readResourceInventory } from './resource-inventory.js'
import { buildCostModel } from './cost-model.js'

export type DashboardSnapshot = Awaited<ReturnType<typeof buildDashboardSnapshot>>

export async function buildDashboardSnapshot(
  environmentId: RelayOpsEnvironmentId,
  gcloud: GcloudClient,
  options: { windowMinutes?: number; fetchImpl?: typeof fetch; now?: Date } = {}
) {
  const generatedAt = (options.now ?? new Date()).toISOString()
  const environment = relayOpsEnvironment(environmentId)
  const [monitoringResult, resourceResult, workflowResult] = await Promise.allSettled([
    readMonitoringSnapshot(environment, gcloud, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.windowMinutes === undefined ? {} : { windowMinutes: options.windowMinutes }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    }),
    readResourceInventory(environment, gcloud, options.fetchImpl),
    readRelayWorkflowRuns()
  ])
  if (monitoringResult.status === 'rejected' || resourceResult.status === 'rejected') {
    const failed = [
      monitoringResult.status === 'rejected' ? 'Monitoring snapshot' : null,
      resourceResult.status === 'rejected' ? 'Resource inventory' : null
    ].filter(Boolean)
    throw new Error(`${failed.join(' and ')} unavailable`)
  }
  const resources = resourceResult.value
  const monitoring = monitoringResult.value
  const warnings = [...resources.warnings, ...monitoring.warnings]
  const poweredDigests = new Set(
    resources.cells.filter((cell) => (cell.targetSize ?? 0) > 0).map((cell) => cell.imageDigest)
  )
  if (poweredDigests.has(null)) warnings.push('A powered cell image digest is unavailable.')
  if (poweredDigests.size > 1) warnings.push('Powered cells are not serving one immutable digest.')
  const expectedCertificateDomain = `*.${new URL(environment.cells[0]!.origin).hostname
    .split('.').slice(1).join('.')}`
  if (resources.certificate && !resources.certificate.domains.includes(expectedCertificateDomain)) {
    warnings.push('The Relay certificate domain does not match the configured cell domain.')
  }
  if (workflowResult.status === 'rejected') warnings.push('GitHub workflow history is unavailable.')
  const observedConnections = monitoring.metrics.total_connections.latest ?? 0
  const observedControls = monitoring.metrics.controls.latest ?? 0
  const observedSplices = monitoring.metrics.splices.latest ?? 0
  const configuredCapacity = environment.cells
    .filter((cell) => cell.configuredAdmission)
    .reduce((sum, cell) => sum + cell.capacityRequests, 0)
  const cellInventoryAvailable = resources.cells.every((cell) => cell.targetSize !== null)
  const poweredCapacity = cellInventoryAvailable
    ? resources.cells
        .filter((cell) => (cell.targetSize ?? 0) > 0)
        .reduce((sum, cell) => sum + cell.capacityRequests, 0)
    : null
  return {
    schemaVersion: 1,
    generatedAt,
    environment: {
      id: environment.id,
      label: environment.label,
      project: environment.project,
      region: environment.region,
      directorOrigin: environment.directorOrigin,
      authOrigin: environment.authOrigin,
      consoleLinks: {
        project: `https://console.cloud.google.com/home/dashboard?project=${environment.project}`,
        alerts: `https://console.cloud.google.com/monitoring/alerting?project=${environment.project}`,
        compute: `https://console.cloud.google.com/compute/instanceGroups/list?project=${environment.project}`
      }
    },
    summary: {
      observedConnections,
      observedControls,
      observedSplices,
      configuredCapacity,
      poweredCapacity,
      activeCells: cellInventoryAvailable
        ? resources.cells.filter(
            (cell) => (cell.targetSize ?? 0) > 0 && cell.backendHealth === 'healthy'
          ).length
        : null,
      totalCells: resources.cells.length
    },
    resources,
    monitoring,
    workflows: workflowResult.status === 'fulfilled' ? workflowResult.value : [],
    cost: buildCostModel(environment, resources),
    warnings,
    stale: false,
    staleReason: null as string | null
  }
}

type SnapshotCacheEntry = { snapshot: DashboardSnapshot; expiresAt: number }
type SnapshotBuilder = (
  environment: RelayOpsEnvironmentId,
  gcloud: GcloudClient,
  options: { windowMinutes?: number }
) => Promise<DashboardSnapshot>

export class DashboardSnapshotCache {
  private readonly entries = new Map<string, SnapshotCacheEntry>()
  private readonly pending = new Map<string, Promise<DashboardSnapshot>>()
  private readonly lastGood = new Map<RelayOpsEnvironmentId, DashboardSnapshot>()

  constructor(
    private readonly gcloud: GcloudClient,
    private readonly ttlMs = 30_000,
    private readonly builder: SnapshotBuilder = buildDashboardSnapshot
  ) {}

  async read(environment: RelayOpsEnvironmentId, windowMinutes: number): Promise<DashboardSnapshot> {
    const key = `${environment}:${windowMinutes}`
    const cached = this.entries.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.snapshot
    const existing = this.pending.get(key)
    if (existing) return await existing
    const request = this.builder(environment, this.gcloud, { windowMinutes })
      .then((snapshot) => {
        const coreInventoryUnavailable =
          snapshot.resources.director === null &&
          snapshot.resources.auth === null &&
          snapshot.resources.sql === null &&
          snapshot.resources.cells.every((cell) => cell.targetSize === null)
        const monitoringCredentialsUnavailable = snapshot.monitoring.warnings.some(
          (warning) => warning.includes('credentials are unavailable')
        )
        const lastGood = this.lastGood.get(environment)
        const result = (coreInventoryUnavailable || monitoringCredentialsUnavailable) && lastGood
          ? {
              ...lastGood,
              stale: true,
              staleReason: 'Local Google Cloud credentials are temporarily unavailable.',
              warnings: [...new Set([...lastGood.warnings, ...snapshot.warnings])]
            }
          : snapshot
        if (!coreInventoryUnavailable && !monitoringCredentialsUnavailable) {
          this.lastGood.set(environment, snapshot)
        }
        this.entries.set(key, { snapshot: result, expiresAt: Date.now() + this.ttlMs })
        return result
      })
      .catch((error: unknown) => {
        const lastGood = this.lastGood.get(environment)
        if (!lastGood) throw error
        const stale = {
          ...lastGood,
          stale: true,
          staleReason: 'The latest operations refresh failed; showing the last good snapshot.',
          warnings: [...new Set([
            ...lastGood.warnings,
            'The latest operations refresh failed before a complete snapshot was available.'
          ])]
        }
        this.entries.set(key, { snapshot: stale, expiresAt: Date.now() + this.ttlMs })
        return stale
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, request)
    return await request
  }
}
