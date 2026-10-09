import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: these alerts key on event names and field paths the relay writes (the rejection fence and
// the lease shadow). A rename on either side silences the alert without failing anything.

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

test('the fence metrics count the exact events on directors and cells', () => {
  for (const [key, event] of [
    ['database_rejection_fenced', 'orca_relay_database_rejection_fenced'],
    ['process_fatal', 'orca_relay_process_fatal']
  ]) {
    const metric = incidentMetric(key)
    assert.ok(metric.includes(`jsonPayload.event=\\"${event}\\"`), key)
    assert.ok(metric.includes('resource.type=\\"cloud_run_revision\\"'), key)
    assert.ok(metric.includes('resource.type=\\"gce_instance\\"'), key)
  }
})

test('each fence alert pages on its own metric, on both process kinds, at the first event', () => {
  for (const [policy, metric] of [
    ['relay_process_fatal', 'orca_relay_process_fatal'],
    ['relay_database_rejection_fenced', 'orca_relay_database_rejection_fenced']
  ]) {
    const body = block('google_monitoring_alert_policy', policy)
    assert.ok(body.includes(`logging.googleapis.com/user/${metric}\\"`), policy)
    assert.match(body, /"Cloud Run"\s*=\s*"cloud_run_revision"/, policy)
    assert.match(body, /"GCE cell"\s*=\s*"gce_instance"/, policy)
    assert.match(body, /threshold_value = 0\n/, policy)
  }
})

test('the lease shadow metrics extract every class the cell writes', () => {
  const classes = [
    'agree',
    'disagree',
    'absent',
    'expired',
    'badSignature',
    'wrongHost',
    'wrongCell',
    'epochBehind',
    'epochAhead'
  ]
  for (const field of classes) {
    assert.match(terraform, new RegExp(`field = "classes\\.${field}"`), field)
  }
  assert.match(terraform, /field = "dbReadMs\.p99"/)
  const metric = block('google_logging_metric', 'relay_assignment_lease_shadow')
  assert.ok(metric.includes('jsonPayload.event=\\"orca_relay_assignment_lease_shadow\\"'))
  const alert = block('google_monitoring_alert_policy', 'relay_assignment_lease_bad_signature')
  assert.ok(alert.includes('user_orca_relay_assignment_lease_shadow_bad_signature_sum'))
})
