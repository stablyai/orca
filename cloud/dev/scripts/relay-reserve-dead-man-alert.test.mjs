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
const poller = read('../../apps/relay/src/shadow-seat-directory.ts')
const watch = read('./watch-relay-reserve-cell.mjs')
const githubActions = read('../../infra/terraform/relay-github-actions.tf')

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

test('the withheld dead-cell verdict alert counts every director withheld line, gated off by default', () => {
  const event = 'orca_relay_dead_cell_verdict_withheld'
  assert.match(poller, new RegExp(`event: '${event}', cellId, \\.\\.\\.verdict`))
  const metric = block('google_logging_metric', 'relay_dead_cell_verdict_withheld')
  assert.ok(metric.includes(`jsonPayload.event=\\"${event}\\""`))
  assert.ok(metric.includes('withheld = "EXTRACT(jsonPayload.withheld)"'))
  const alert = block('google_monitoring_alert_policy', 'relay_dead_cell_verdict_withheld')
  for (const body of [metric, alert]) assert.match(body, /count = var\.relay_dead_cell_verdict_alert \? 1 : 0/)
  assert.match(alert, /threshold_value = 0\n/)
  assert.match(alert, /notification_channels = var\.relay_alert_notification_channels/)
  assert.ok(alert.includes('logging.googleapis.com/user/${google_logging_metric.relay_dead_cell_verdict_withheld[0].name}'))
  assert.ok(alert.includes('group_by_fields      = ["metric.label.\\"withheld\\""]'))
  assert.match(read('../../infra/terraform/variables.tf'), /variable "relay_dead_cell_verdict_alert" \{[\s\S]*?default     = false/)
  assert.match(read('../../infra/terraform/environments/staging.tfvars'), /relay_dead_cell_verdict_alert\s+= true/)
})

test('the reserve watch alarm pages on any line the watch runner writes, per cell', () => {
  // The runner writes a global-resource entry under its own log name.
  assert.match(watch, /export const ALARM_EVENT = 'orca_relay_reserve_watch_alarm'/)
  assert.match(watch, /export const ALARM_LOG_NAME = 'orca-relay-reserve-watch'/)
  assert.match(watch, /JSON\.stringify\(\{ event: ALARM_EVENT, cellId, kind, reason \}\)/)
  const metric = block('google_logging_metric', 'relay_reserve_watch_alarm')
  assert.ok(
    metric.includes(
      'resource.type=\\"global\\" AND logName=\\"projects/${var.project_id}/logs/orca-relay-reserve-watch\\" AND jsonPayload.event=\\"orca_relay_reserve_watch_alarm\\"'
    )
  )
  assert.ok(metric.includes('cell_id = "EXTRACT(jsonPayload.cellId)"'))
  notifyingOnAnyLine('relay_reserve_watch_alarm', 'orca_relay_reserve_watch_alarm', 'global', 'cell_id')
  // The deploy identity the workflow runs as can write that line, and only in production.
  const grant = /resource "google_project_iam_member" "github_log_writer" \{([\s\S]*?)\n\}/.exec(githubActions)?.[1]
  assert.ok(grant, 'github_log_writer grant not found')
  assert.match(grant, /count = local\.relay_create_production_ops_identity \? 1 : 0/)
  assert.match(grant, /role    = "roles\/logging\.logWriter"/)
  assert.match(grant, /member  = google_service_account\.github_deploy\[0\]\.member/)
})
