import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: each metric keys on the event name and fields the relay writes. A rename on either side
// silences the alert without failing anything.

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const terraform = read('../../infra/terraform/relay-observability.tf')
const deadMan = read('../../apps/relay/src/cell-reserve-dead-man.ts')
const registry = read('../../apps/relay/src/host-session-registry.ts')
const server = read('../../apps/relay/src/relay-server.ts')

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

const notifyingOnAnyLine = (name, event, resource, group) => {
  const alert = block('google_monitoring_alert_policy', name)
  assert.match(alert, /threshold_value = 0\n/)
  assert.match(alert, /notification_channels = var\.relay_alert_notification_channels/)
  assert.ok(alert.includes(`resource.type=\\"${resource}\\" AND metric.type=\\"logging.googleapis.com/user/${event}\\"`))
  assert.ok(alert.includes(`group_by_fields      = ["metric.label.\\"${group}\\""]`))
}

test('the flip-back alerts count the lines the cell writes, per cell', () => {
  for (const event of ['orca_relay_cell_reregistration_gave_up', 'orca_relay_cell_reregistration_stalled']) {
    // logIdentity() carries cellId; both lines name the reason.
    assert.match(registry, new RegExp(`event: '${event}',\\s*\\.\\.\\.this\\.logIdentity\\(\\),[\\s\\S]{0,200}reason:`))
    const name = event.replace('orca_', '')
    const metric = block('google_logging_metric', name)
    assert.ok(metric.includes(`resource.type=\\"gce_instance\\" AND jsonPayload.event=\\"${event}\\"`))
    assert.ok(metric.includes('cell_id = "EXTRACT(jsonPayload.cellId)"'))
    assert.ok(metric.includes('reason  = "EXTRACT(jsonPayload.reason)"'))
    notifyingOnAnyLine(name, event, 'gce_instance', 'cell_id')
  }
  assert.match(registry, /cellId: this\.config\.cellId/)
})

test('the director alert counts its placement-off line on the director service', () => {
  const event = 'orca_relay_reserve_placement_off_with_reserve_cells'
  assert.match(server, new RegExp(`event: '${event}',\\s*cells,`))
  const metric = block('google_logging_metric', 'relay_reserve_placement_off_with_reserve_cells')
  assert.ok(
    metric.includes(
      `resource.type=\\"cloud_run_revision\\" AND resource.labels.service_name=\\"\${var.relay_cloud_run_service_name}\\" AND jsonPayload.event=\\"${event}\\"`
    )
  )
  notifyingOnAnyLine('relay_reserve_placement_off_with_reserve_cells', event, 'cloud_run_revision', 'revision')
})
