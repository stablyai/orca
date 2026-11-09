const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts } = require('./arkts-source.cjs')
const upstream = require('../../entry/src/main/ets/vendor/connection-diagnostics.js')

const options = {
  upstream,
  url: { URL },
  utf8Encode: (text) => new TextEncoder().encode(text),
  uiText: (key) => key
}
const {
  redactDiagnosticText,
  connectionReport,
  reportableIncident,
  resolveDesktopEndpoint,
  describeDesktopConnection
} = loadArkts(
  'diagnostics/ConnectionDiagnostics.ets',
  [
    'redactDiagnosticText',
    'connectionReport',
    'reportableIncident',
    'resolveDesktopEndpoint',
    'describeDesktopConnection'
  ],
  options
)

test('desktop outage severity survives redials and clears on authenticated reconnect', () => {
  const evidence = {
    endpoint: 'ws://test.invalid:18797',
    hostName: 'Test desktop',
    state: 'reconnecting',
    lastConnectedAt: 1000,
    nowMs: 62_000
  }
  const describe = (state, reconnectAttempts) =>
    describeDesktopConnection({ ...evidence, state, reconnectAttempts }, 'en').kind
  assert.equal(describe('reconnecting', 1), 'normal')
  assert.equal(describe('reconnecting', 3), 'warning')
  assert.equal(describe('connecting', 12), 'unreachable')
  assert.equal(describe('connected', 0), 'normal')
  assert.equal(describe('auth-failed', 0), 'auth-failed')
})

test('desktop reports use the selected host history and exclude credentials and unscoped legacy events', async () => {
  let saved = JSON.stringify([{ ts: 1000, level: 'info', message: 'Legacy unscoped event' }])
  const { appendLog, listLogs } = loadArkts(
    'diagnostics/ConnectionLogStore.ets',
    ['appendLog', 'listLogs'],
    {
      redactDiagnosticText,
      preferences: {
        getPreferences: async () => ({
          get: async () => saved,
          put: async (_key, value) => {
            saved = value
          },
          flush: async () => {}
        })
      }
    }
  )
  await appendLog(
    {},
    'warn',
    'Alpha relay closed',
    'deviceToken=private-alpha orca://pair?code=private-link',
    'alpha',
    'relay-session-failed',
    'relay'
  )
  await appendLog({}, 'success', 'Beta connected', '', 'beta', 'direct-connected', 'lan')
  const entries = await listLogs({}, 'alpha')
  const evidence = {
    endpoint: 'wss://alpha.example.invalid',
    state: 'reconnecting',
    activePath: 'relay',
    entries
  }
  const report = connectionReport(
    {
      ...evidence,
      hostName: 'Alpha',
      reconnectAttempts: 1,
      lastConnectedAt: null,
      desktopAppVersion: null,
      appVersion: '0.1.0',
      platform: 'harmonyos',
      bridgeProtocolVersion: 1
    },
    entries
  )
  assert.match(report, /Host: Alpha\nEndpoint: alpha\.example\.invalid/)
  assert.match(report, /Alpha relay closed/)
  assert.match(report, /deviceToken=\[redacted\] \[redacted pairing link\]/)
  assert.doesNotMatch(saved, /private-alpha|private-link/)
  assert.doesNotMatch(report, /Beta connected|Legacy unscoped event/)
  assert.equal(reportableIncident(evidence), entries[0].id)
  assert.equal(reportableIncident({ ...evidence, state: 'connected' }), null)
})

test('editing a bare desktop address preserves the saved port and WebSocket route', () => {
  const edit = resolveDesktopEndpoint(
    'wss://alpha.example.invalid:7443/orca',
    'other.example.invalid'
  )
  assert.equal(edit.endpoint, 'wss://other.example.invalid:7443/orca')
  assert.equal(
    resolveDesktopEndpoint('wss://alpha.example.invalid:7443/orca', 'other.example.invalid:0').kind,
    'invalid'
  )
})
