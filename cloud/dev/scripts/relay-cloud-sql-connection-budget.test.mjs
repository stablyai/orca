import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  calculateRelayCloudSqlConnectionBudget,
  readRelayCloudSqlConnectionBudget
} from './relay-cloud-sql-connection-budget.mjs'

const arithmetic = (report) =>
  [
    `cells ${report.consumers.cells}`,
    `directors ${report.consumers.directors}`,
    `auth ${report.consumers.auth}`,
    `api ${report.consumers.api}`,
    `= ${report.configuredMaximum} configured`,
    `+ ${report.rolloutOverlap.maximum} rollout overlap`,
    `+ ${report.maintenanceAdminAllowance} admin allowance`,
    `= ${report.operatingMaximum} operating`,
    `against ${report.maxConnections} max_connections less a ${report.explicitReserve} reserve`
  ].join(', ')

test('the production budget reads the committed pools and the measured ceiling', () => {
  // cells: 20 pools at 10 (200) + the three asia-east2 pools at 16 (48).
  const report = readRelayCloudSqlConnectionBudget()

  assert.equal(report.maxConnections, 500)
  assert.deepEqual(report.consumers, { cells: 248, directors: 15, auth: 200, api: 50 })
  assert.deepEqual(report.asia, { cells: 3, poolMax: 16 })
  assert.equal(report.configuredMaximum, 513)
  // The director candidate inherits a floor of 5 and dual-serves; auth and API candidates hold
  // one instance each until their traffic flip, so the director roll is now the widest overlap.
  assert.equal(report.rolloutOverlap.relayDirectorCandidate, 30)
  assert.equal(report.rolloutOverlap.apiCandidate, 20)
  assert.equal(report.rolloutOverlap.authCandidate, 25)
  assert.equal(report.rolloutOverlap.relayCells, 15)
  assert.equal(report.rolloutOverlap.retainedDirectorRollback, 15)
  assert.equal(report.rolloutOverlap.maximum, 30)
  assert.equal(report.maintenanceAdminAllowance, 5)
  assert.equal(report.explicitReserve, 10)
  assert.equal(report.usableCeiling, 490)
  assert.equal(report.operatingMaximum, 548)
})

test('configured pools fit under the ceiling less the stated reserve', () => {
  const report = readRelayCloudSqlConnectionBudget()

  assert.ok(
    report.configuredMaximum <= report.usableCeiling,
    `configured pools exceed the usable ceiling: ${arithmetic(report)}`
  )
})

test('a serialized rollout still fits under the ceiling less the stated reserve', () => {
  const report = readRelayCloudSqlConnectionBudget()

  assert.ok(report.withinBudget, `the operating maximum exceeds the usable ceiling: ${arithmetic(report)}`)
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
    authCandidateMinInstances: 2,
    apiInstances: 20,
    apiPoolMax: 5,
    apiCandidateMinInstances: 20,
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
    appConsumers: {
        authInstances: 1,
        authPoolMax: 10,
        authCandidateMinInstances: 1,
        apiInstances: 1,
        apiPoolMax: 5,
        apiCandidateMinInstances: 1,
        maxConnections: 100
      },
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
  assert.equal(report.operatingMaximum, 46)
  assert.equal(report.budgetedTotal, 47)
})

test('dedicated push scaling does not consume shared capacity', () => {
  const report = readRelayCloudSqlConnectionBudget({
    proposedAsiaCellCount: 1,
    appConsumers: {
        authInstances: 1,
        authPoolMax: 10,
        authCandidateMinInstances: 1,
        apiInstances: 1,
        apiPoolMax: 5,
        apiCandidateMinInstances: 1,
        maxConnections: 100
      },
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

  assert.equal(report.consumers.push, undefined)
  assert.equal(report.rolloutOverlap.pushCandidate, undefined)
  assert.equal(report.operatingMaximum, 46)
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
    authCandidateMinInstances: 1,
    apiInstances: 1,
    apiPoolMax: 5,
    apiCandidateMinInstances: 1,
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
