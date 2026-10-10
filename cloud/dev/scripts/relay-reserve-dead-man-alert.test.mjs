import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: the metric keys on the event name and field the dead-man writes. A rename on either side
// silences the alert without failing anything.

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const terraform = read('../../infra/terraform/relay-observability.tf')
const deadMan = read('../../apps/relay/src/cell-reserve-dead-man.ts')

const block = (kind, name) => {
  const body = new RegExp(`resource "${kind}" "${name}" \\{([\\s\\S]*?)\\n\\}`).exec(terraform)?.[1]
  assert.ok(body, `${kind}.${name} not found in relay-observability.tf`)
  return body
}

test('the metric counts the event and cell the dead-man writes', () => {
  assert.match(deadMan, /event: 'orca_relay_cell_reserve_dead_man_tripped',\s*cellId: this\.cellId,/)
  const metric = block('google_logging_metric', 'relay_cell_reserve_dead_man_tripped')
  assert.ok(metric.includes('jsonPayload.event=\\"orca_relay_cell_reserve_dead_man_tripped\\"'))
  assert.ok(metric.includes('cell_id = "EXTRACT(jsonPayload.cellId)"'))
})

test('the alert fires on one trip per cell and notifies', () => {
  const alert = block('google_monitoring_alert_policy', 'relay_cell_reserve_dead_man_tripped')
  // One line per switch-file generation, so a higher bar misses a trip.
  assert.match(alert, /threshold_value = 0\n/)
  assert.match(alert, /notification_channels = var\.relay_alert_notification_channels/)
  assert.ok(alert.includes('metric.type=\\"logging.googleapis.com/user/orca_relay_cell_reserve_dead_man_tripped\\"'))
  assert.ok(alert.includes('group_by_fields      = ["metric.label.\\"cell_id\\""]'))
})
