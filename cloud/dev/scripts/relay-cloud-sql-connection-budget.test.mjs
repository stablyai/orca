import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  calculateRelayCloudSqlConnectionBudget,
  readRelayCloudSqlConnectionBudget
} from './relay-cloud-sql-connection-budget.mjs'

test('production plus three Asia pools preserves allowance and reserve below the ceiling', () => {
  const report = readRelayCloudSqlConnectionBudget()

  assert.deepEqual(report.consumers, { cells: 230, directors: 15, auth: 20, api: 50 })
  assert.deepEqual(report.asia, { cells: 3, poolMax: 10 })
  assert.equal(report.configuredMaximum, 315)
  assert.equal(report.rolloutOverlap.relayDirectorCandidate, 30)
  assert.equal(report.rolloutOverlap.apiCandidate, 65)
  assert.equal(report.rolloutOverlap.authCandidate, 35)
  assert.equal(report.rolloutOverlap.relayCells, 15)
  assert.equal(report.rolloutOverlap.retainedDirectorRollback, 15)
  assert.equal(report.rolloutOverlap.maximum, 65)
  assert.equal(report.maintenanceAdminAllowance, 5)
  assert.equal(report.explicitReserve, 10)
  assert.equal(report.usableCeiling, 390)
  assert.equal(report.operatingMaximum, 385)
  assert.equal(report.remainingWithinUsableCeiling, 5)
  assert.equal(report.budgetedTotal, 395)
  assert.equal(report.unallocated, 5)
  assert.equal(report.withinBudget, true)
})

test('fails closed when pool growth consumes the explicit reserve', () => {
  const report = calculateRelayCloudSqlConnectionBudget({
    cellPoolTotal: 200,
    asiaCellCount: 3,
    asiaPoolMax: 20,
    directorInstances: 5,
    directorPoolMax: 3,
    authInstances: 2,
    authPoolMax: 10,
    apiInstances: 20,
    apiPoolMax: 5,
    maxConnections: 400,
    maintenanceAdminAllowance: 5,
    explicitReserve: 10
  })

  assert.equal(report.operatingMaximum, 515)
  assert.equal(report.withinBudget, false)
})

test('excludes fenced cell pools and reads per-cell pool overrides', () => {
  const report = readRelayCloudSqlConnectionBudget({
    proposedAsiaCellCount: 1,
    appConsumers: { authInstances: 1, authPoolMax: 10, apiInstances: 1, apiPoolMax: 5, maxConnections: 100 },
    sources: {
      productionTfvars: `
        relay_max_instances = 1
        relay_gce_fenced_cells = ["production-gce-c1"]
        relay_gce_cells = {
          "production-gce-c1" = { database_pool_max = 99
          }
          "production-gce-c2" = { database_pool_max = 4
          }
        }
      `,
      terraformVariables: 'variable "relay_director_database_pool_max" { default = 3 }',
      relayConfig: 'export const RELAY_DATABASE_POOL_MAX = 10'
    },
    maxConnections: 100,
    maintenanceAdminAllowance: 1,
    explicitReserve: 1
  })

  assert.equal(report.consumers.cells, 14)
  assert.equal(report.operatingMaximum, 46)
  assert.equal(report.budgetedTotal, 47)
})

test('requires strict headroom below the physical ceiling', () => {
  const report = calculateRelayCloudSqlConnectionBudget({
    cellPoolTotal: 20,
    asiaCellCount: 0,
    asiaPoolMax: 10,
    directorInstances: 1,
    directorPoolMax: 3,
    authInstances: 1,
    authPoolMax: 10,
    apiInstances: 1,
    apiPoolMax: 5,
    maxConnections: 50,
    maintenanceAdminAllowance: 9,
    explicitReserve: 3
  })

  assert.equal(report.budgetedTotal, 63)
  assert.equal(report.withinBudget, false)
})

test('pages Relay channels when Cloud SQL backends consume headroom', () => {
  const terraform = readFileSync(
    new URL('../../infra/terraform/relay-observability.tf', import.meta.url),
    'utf8'
  )
  const policy = terraform.match(
    /resource "google_monitoring_alert_policy" "relay_cloud_sql_backends" \{([\s\S]*?)\n\}/
  )?.[1]

  assert.ok(policy)
  assert.match(policy, /notification_channels\s*=\s*var\.relay_alert_notification_channels/)
})
