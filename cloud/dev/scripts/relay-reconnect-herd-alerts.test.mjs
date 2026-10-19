import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: both herd alerts key on text the relay writes (a log line and a runtime field). A rename on
// either side silences the alert without failing anything.

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

test('the disconnect-burst metric matches the line a cell writes per control close', () => {
  const emitter = read('../../apps/relay/src/host-session-registry.ts')
  assert.match(emitter, /`\[orca-relay\] control closed host=\$\{/)
  assert.match(emitter, /` code=\$\{code\} reason=\$\{/)
  const metric = incidentMetric('cell_control_abnormal_closes')
  assert.match(metric, /jsonPayload\.message:\\"\[orca-relay\] control closed \\"/)
  assert.match(metric, /jsonPayload\.message:\\" code=1006 \\"/)
  assert.match(metric, /logs\/cos_containers/)
  const policy = block('google_monitoring_alert_policy', 'relay_cell_control_close_burst')
  assert.match(policy, /orca_relay_cell_control_abnormal_closes/)
  assert.match(policy, /group_by_fields\s*=\s*\["resource\.label\.\\"instance_id\\""\]/)
})

test('the pool-herd metric thresholds the interval maximum the relay emits', () => {
  const emitter = read('../../apps/relay/src/postgres-pool-pressure.ts')
  assert.match(emitter, /\bdatabasePoolWaitersMax: number\b/)
  const metric = block('google_logging_metric', 'relay_cell_pool_herd')
  // 200, not lower: single-cell stalls of 50-196 waiters recur daily; herds go past 200.
  assert.match(metric, /jsonPayload\.databasePoolWaitersMax>200"/)
  const policy = block('google_monitoring_alert_policy', 'relay_cell_pool_herd')
  assert.match(policy, /threshold_value\s*=\s*0\n/)
})
