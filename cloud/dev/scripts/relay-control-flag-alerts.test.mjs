import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: the metric keys on the event name and fields the switch-file reader writes. A rename on
// either side silences the alert without failing anything.

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const terraform = read('../../infra/terraform/relay-observability.tf')
const channel = read('../../apps/relay/src/relay-control-flag-channel.ts')
const cellFlags = read('../../apps/relay/src/cell-flags.ts')

const block = (kind, name) => {
  const body = new RegExp(`resource "${kind}" "${name}" \\{([\\s\\S]*?)\\n\\}`).exec(terraform)?.[1]
  assert.ok(body, `${kind}.${name} not found in relay-observability.tf`)
  return body
}

test('the metric counts the event and fields the reader writes', () => {
  const unreadableLine = /event: 'orca_relay_control_flags_unreadable',\s*object: input\.objectName,\s*failure,/
  assert.match(channel, unreadableLine)
  assert.match(cellFlags, /return `cells\/\$\{cellId\}\.json`/)
  const metric = block('google_logging_metric', 'relay_control_flags_unreadable')
  assert.ok(metric.includes('jsonPayload.event=\\"orca_relay_control_flags_unreadable\\"'))
  assert.ok(metric.includes('REGEXP_EXTRACT(jsonPayload.object, \\"cells/([^.]+)\\")'))
  assert.ok(metric.includes('failure = "EXTRACT(jsonPayload.failure)"'))
})

test('the alert fires on one line per cell and stays in the console', () => {
  const alert = block('google_monitoring_alert_policy', 'relay_control_flags_unreadable')
  // The reader logs once per change of cause, so a stuck cell writes one line; a higher bar misses it.
  assert.match(alert, /threshold_value = 0\n/)
  assert.match(alert, /notification_channels = \[\]/)
  assert.ok(alert.includes('metric.type=\\"logging.googleapis.com/user/orca_relay_control_flags_unreadable\\"'))
  assert.ok(alert.includes('group_by_fields      = ["metric.label.\\"cell_id\\""]'))
})
