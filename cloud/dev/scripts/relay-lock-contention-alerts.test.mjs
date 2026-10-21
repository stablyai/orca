import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: both lock alerts key on text another component writes (a relay runtime field and a
// Postgres error message). A rename on either side silences the alert without failing anything.

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const terraform = read('../../infra/terraform/relay-observability.tf')

const block = (kind, name) => {
  const body = new RegExp(`resource "${kind}" "${name}" \\{([\\s\\S]*?)\\n\\}`).exec(terraform)?.[1]
  assert.ok(body, `${kind}.${name} not found in relay-observability.tf`)
  return body
}

const incidentMetric = (key) => {
  const body = new RegExp(`\\n    ${key} = \\{([\\s\\S]*?)\\n    \\}`).exec(terraform)?.[1]
  assert.ok(body, `relay_incident_metrics.${key} not found`)
  return body
}

test('the long-hold metric thresholds the field the relay emits', () => {
  const emitter = read('../../apps/relay/src/cell-inventory-hold-samples.ts')
  assert.match(emitter, /\bcellInventoryHoldMsMax: number\b/)
  const metric = block('google_logging_metric', 'relay_long_cell_inventory_hold')
  assert.match(metric, /filter\s*=\s*"\$\{local\.relay_runtime_log_filter\} AND jsonPayload\.cellInventoryHoldMsMax>=1000"/)
  assert.match(metric, /value_extractor\s*=\s*"EXTRACT\(jsonPayload\.cellInventoryHoldMsMax\)"/)
})

test('the long-hold buckets start at the filter bar so any sample reads above zero', () => {
  const metric = block('google_logging_metric', 'relay_long_cell_inventory_hold')
  const bounds = /bounds\s*=\s*\[([^\]]*)\]/.exec(metric)?.[1].split(',').map(Number)
  assert.ok(bounds && bounds.length > 0)
  assert.equal(bounds[0], 1000)
  for (const name of ['relay_long_cell_inventory_hold', 'relay_director_cell_inventory_hold']) {
    const policy = block('google_monitoring_alert_policy', name)
    const conditions = [...policy.matchAll(/threshold_value\s*=\s*(\d+)\n/g)]
    assert.ok(conditions.length > 0)
    for (const match of conditions) assert.equal(match[1], '0')
  }
})

test('only cell holds page; director holds stay visible without paging', () => {
  // Director holds recur with rehoming paused, and the paging runbook's first step is to pause it.
  const paging = block('google_monitoring_alert_policy', 'relay_long_cell_inventory_hold')
  const pagingRoles = [...paging.matchAll(/metric\.label\.\\"role\\"=\\"([a-z]+)\\"/g)].map((m) => m[1])
  assert.ok(pagingRoles.length > 0)
  assert.deepEqual([...new Set(pagingRoles)], ['cell'])
  assert.equal([...paging.matchAll(/condition_threshold \{/g)].length, pagingRoles.length)

  const director = block('google_monitoring_alert_policy', 'relay_director_cell_inventory_hold')
  const directorRoles = [...director.matchAll(/metric\.label\.\\"role\\"=\\"([a-z]+)\\"/g)].map((m) => m[1])
  assert.deepEqual(directorRoles, ['director'])
  assert.match(director, /notification_channels\s*=\s*\[\]/)
})

test('the lock-timeout metric counts relay cancels only, never NOWAIT refusals or auth', () => {
  const metric = incidentMetric('cloud_sql_lock_timeouts')
  const filter = /filter\s*=\s*"(.*)"$/m.exec(metric)?.[1]
  assert.ok(filter)
  assert.match(filter, /resource\.type=\\"cloudsql_database\\"/)
  assert.match(filter, /textPayload:\\"db=orca_relay,\\"/)
  assert.match(filter, /textPayload:\\"canceling statement due to lock timeout\\"/)
  // Would match the `SET LOCAL lock_timeout` STATEMENT line Postgres logs after every cancel.
  assert.doesNotMatch(filter, /lock_timeout/)
  // Background sweeps refuse at ~160/min with rehome paused; including them pins the alert on.
  assert.doesNotMatch(filter, /could not obtain lock/)
})

test('the burst policy fires at 20 relay cancels in a minute and pages the relay channel', () => {
  const policy = block('google_monitoring_alert_policy', 'relay_lock_timeout_burst')
  assert.match(policy, /logging\.googleapis\.com\/user\/orca_relay_cloud_sql_lock_timeouts/)
  assert.match(policy, /comparison\s*=\s*"COMPARISON_GT"\s*\n\s*threshold_value\s*=\s*19\n/)
  assert.match(policy, /alignment_period\s*=\s*"60s"\s*\n\s*per_series_aligner\s*=\s*"ALIGN_SUM"/)
  for (const name of ['relay_lock_timeout_burst', 'relay_long_cell_inventory_hold']) {
    assert.match(
      block('google_monitoring_alert_policy', name),
      /notification_channels\s*=\s*var\.relay_alert_notification_channels/
    )
  }
})
