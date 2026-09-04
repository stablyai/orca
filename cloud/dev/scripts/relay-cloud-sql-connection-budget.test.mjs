import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  calculateRelayCloudSqlConnectionBudget,
  readRelayCloudSqlConnectionBudget
} from './relay-cloud-sql-connection-budget.mjs'

// Why these numbers are this tight: the shared instance's 400 connections were already spoken
// for, and the relay shape below leaves exactly five. The gateway is sized to fit in four, two
// instances times a two-connection pool, and its rollout overlap of 23 stays under the API
// candidate's 65, so the Math.max is the API candidate rather than the gateway.
//
// `Deploy Relay Asia Topology` gates on `withinBudget == true`, so the single remaining
// connection is the whole margin. Anything that raises a pool or an instance count moves it.
test('production plus the push gateway keeps allowance and reserve below the ceiling', () => {
  const report = readRelayCloudSqlConnectionBudget()

  assert.deepEqual(report.consumers, { cells: 230, directors: 15, auth: 20, api: 50, push: 4 })
  assert.deepEqual(report.asia, { cells: 3, poolMax: 10 })
  assert.equal(report.configuredMaximum, 319)
  assert.equal(report.rolloutOverlap.relayDirectorCandidate, 30)
  assert.equal(report.rolloutOverlap.apiCandidate, 65)
  assert.equal(report.rolloutOverlap.authCandidate, 35)
  assert.equal(report.rolloutOverlap.pushCandidate, 23)
  assert.equal(report.rolloutOverlap.relayCells, 15)
  assert.equal(report.rolloutOverlap.retainedDirectorRollback, 15)
  // The gateway does not set the maximum; the API candidate does, as it did before it existed.
  assert.equal(report.rolloutOverlap.maximum, 65)
  assert.equal(report.maintenanceAdminAllowance, 5)
  assert.equal(report.explicitReserve, 10)
  assert.equal(report.usableCeiling, 390)
  assert.equal(report.operatingMaximum, 389)
  assert.equal(report.remainingWithinUsableCeiling, 1)
  assert.equal(report.budgetedTotal, 399)
  assert.equal(report.unallocated, 1)
  assert.equal(report.withinBudget, true)
})

// Why: the same relay shape without a push gateway is the before picture, and it stood at five
// connections clear. Holding it here keeps the gateway's cost visible as the four it takes,
// rather than letting drift elsewhere in the budget hide inside the same margin.
test('the same relay shape without the gateway stays inside the ceiling', () => {
  const report = calculateRelayCloudSqlConnectionBudget({
    cellPoolTotal: 200,
    asiaCellCount: 3,
    asiaPoolMax: 10,
    directorInstances: 5,
    directorPoolMax: 3,
    authInstances: 2,
    authPoolMax: 10,
    apiInstances: 10,
    apiPoolMax: 5,
    pushInstances: 0,
    pushPoolMax: 0,
    maxConnections: 400,
    maintenanceAdminAllowance: 5,
    explicitReserve: 10
  })

  assert.equal(report.consumers.push, 0)
  assert.equal(report.rolloutOverlap.maximum, 65)
  assert.equal(report.operatingMaximum, 385)
  assert.equal(report.remainingWithinUsableCeiling, 5)
  assert.equal(report.withinBudget, true)
})

// Why: a tagged candidate is directly addressable and sits outside the service-wide cap, so both
// push revisions can reach the ceiling at once. The API and auth candidates add one copy; this
// one adds two, like the director candidate.
test('the push rollout scenario doubles the gateway draw over the retained director', () => {
  const report = calculateRelayCloudSqlConnectionBudget({
    cellPoolTotal: 0,
    asiaCellCount: 0,
    asiaPoolMax: 0,
    directorInstances: 5,
    directorPoolMax: 3,
    authInstances: 0,
    authPoolMax: 0,
    apiInstances: 0,
    apiPoolMax: 0,
    pushInstances: 2,
    pushPoolMax: 2,
    maxConnections: 400,
    maintenanceAdminAllowance: 5,
    explicitReserve: 10
  })

  assert.equal(report.consumers.push, 4)
  // 15 retained director rollback, plus the 4-connection draw counted twice.
  assert.equal(report.rolloutOverlap.pushCandidate, 23)
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
    pushInstances: 4,
    pushPoolMax: 10,
    maxConnections: 400,
    maintenanceAdminAllowance: 5,
    explicitReserve: 10
  })

  assert.equal(report.operatingMaximum, 555)
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
      terraformVariables: [
        'variable "relay_director_database_pool_max" { default = 3 }',
        'variable "push_max_instances" { default = 1 }',
        'variable "push_database_pool_max" { default = 2 }'
      ].join('\n'),
      relayConfig: 'export const RELAY_DATABASE_POOL_MAX = 10'
    },
    maxConnections: 100,
    maintenanceAdminAllowance: 1,
    explicitReserve: 1
  })

  assert.equal(report.consumers.cells, 14)
  // No push_max_instances in this tfvars, so the variable default of one instance holds.
  assert.equal(report.consumers.push, 2)
  assert.equal(report.operatingMaximum, 48)
  assert.equal(report.budgetedTotal, 49)
})

// Why: production.tfvars overrides push_max_instances down to 2 while variables.tf still defaults
// to 4, so reading the default instead of the override would overstate the live draw by half.
test('a tfvars push_max_instances override wins over the variable default', () => {
  const report = readRelayCloudSqlConnectionBudget({
    proposedAsiaCellCount: 1,
    appConsumers: { authInstances: 1, authPoolMax: 10, apiInstances: 1, apiPoolMax: 5, maxConnections: 100 },
    sources: {
      productionTfvars: `
        relay_max_instances = 1
        push_max_instances  = 3
        relay_gce_fenced_cells = []
        relay_gce_cells = {
          "production-gce-c2" = { database_pool_max = 4
          }
        }
      `,
      terraformVariables: [
        'variable "relay_director_database_pool_max" { default = 3 }',
        'variable "push_max_instances" { default = 1 }',
        'variable "push_database_pool_max" { default = 2 }'
      ].join('\n'),
      relayConfig: 'export const RELAY_DATABASE_POOL_MAX = 10'
    },
    maxConnections: 100,
    maintenanceAdminAllowance: 1,
    explicitReserve: 1
  })

  assert.equal(report.consumers.push, 6)
  assert.equal(report.rolloutOverlap.pushCandidate, 15)
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
    pushInstances: 1,
    pushPoolMax: 2,
    maxConnections: 50,
    maintenanceAdminAllowance: 9,
    explicitReserve: 3
  })

  assert.equal(report.budgetedTotal, 65)
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
