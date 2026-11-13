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

test('a failed diagnostics read keeps disk history and merges live events after storage recovers', async () => {
  const stored = JSON.stringify([
    { id: 'old-alpha', ts: 1000, level: 'warn', message: 'Alpha prior outage', hostId: 'alpha' },
    { id: 'old-beta', ts: 2000, level: 'info', message: 'Beta prior event', hostId: 'beta' }
  ])
  let saved = stored
  let unavailable = true
  let markPersisted
  const persisted = new Promise((resolve) => {
    markPersisted = resolve
  })
  const { appendLog, listLogs } = loadArkts(
    'diagnostics/ConnectionLogStore.ets',
    ['appendLog', 'listLogs'],
    {
      redactDiagnosticText,
      preferences: {
        getPreferences: async () => ({
          get: async () => {
            if (unavailable) {
              throw new Error('storage unavailable')
            }
            return saved
          },
          put: async (_key, value) => {
            saved = value
          },
          flush: async () => {
            markPersisted()
          }
        })
      }
    }
  )
  const context = {}
  await appendLog(context, 'success', 'Alpha restored', '', 'alpha').catch(() => {})
  assert.equal(saved, stored)
  const messages = (entries) => Array.from(entries, (entry) => entry.message)
  assert.deepEqual(messages(await listLogs(context, 'alpha')), ['Alpha restored'])

  unavailable = false
  assert.deepEqual(messages(await listLogs(context, 'alpha')), [
    'Alpha prior outage',
    'Alpha restored'
  ])
  assert.deepEqual(messages(await listLogs(context, 'beta')), ['Beta prior event'])
  await persisted
  assert.deepEqual(messages(JSON.parse(saved)), [
    'Alpha prior outage',
    'Beta prior event',
    'Alpha restored'
  ])
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

test('leaving diagnostics closes a late desktop socket and cannot settle a new run', async () => {
  const sockets = []
  const { TroubleshootProbes } = loadArkts(
    'diagnostics/TroubleshootProbes.ets',
    ['TroubleshootProbes'],
    {
      isDirectEndpoint: () => true,
      webSocket: {
        createWebSocket: () => {
          const events = new Map()
          const socket = {
            opened: false,
            on: (event, callback) => events.set(event, callback),
            connect: async () => true,
            close: async () => {
              socket.opened = false
            },
            open() {
              socket.opened = true
              events.get('open')()
            }
          }
          sockets.push(socket)
          return socket
        }
      }
    }
  )
  const probes = new TroubleshootProbes()
  const cancelled = probes.desktop('ws://first.invalid:6768')
  probes.cancel()
  assert.equal(await cancelled, false)

  const current = probes.desktop('ws://second.invalid:6768')
  sockets[0].open()
  assert.equal(sockets[0].opened, false)
  sockets[1].open()
  assert.equal(await current, true)
  assert.equal(sockets[1].opened, false)
})

test('default-network recovery reacts to a new route and a return from offline, but not initial or repeated events', () => {
  const listeners = new Map()
  let netId = 4
  let gateway = '10.0.2.2'
  let pending
  const changes = []
  const { DefaultNetworkObserver } = loadArkts(
    'transport/DefaultNetworkObserver.ets',
    ['DefaultNetworkObserver'],
    {
      connection: {
        getDefaultNetSync: () => ({ netId }),
        getConnectionPropertiesSync: () => ({
          interfaceName: 'eth0',
          linkAddresses: [{ address: { address: '10.0.2.15' }, prefixLength: 24 }],
          routes: [{ interface: 'eth0', gateway: { address: gateway }, isDefaultRoute: true }]
        }),
        createNetConnection: () => ({
          on: (event, callback) => listeners.set(event, callback),
          register: (callback) => callback(),
          unregister() {}
        })
      },
      setTimeout: (callback) => {
        pending = callback
        return 1
      },
      clearTimeout: () => {
        pending = undefined
      }
    }
  )
  const watch = new DefaultNetworkObserver(() => changes.push(netId))
  const flush = () => {
    const callback = pending
    pending = undefined
    callback?.()
  }
  watch.start()
  listeners.get('netAvailable')()
  flush()
  assert.deepEqual(changes, [])

  gateway = '10.0.2.3'
  listeners.get('netConnectionPropertiesChange')()
  flush()
  listeners.get('netAvailable')()
  flush()
  assert.deepEqual(changes, [4])

  netId = 0
  listeners.get('netLost')()
  flush()
  assert.deepEqual(changes, [4])
  netId = 4
  listeners.get('netAvailable')()
  flush()
  listeners.get('netLost')()
  listeners.get('netAvailable')()
  flush()
  netId = 9
  listeners.get('netAvailable')()
  watch.stop()
  flush()
  assert.deepEqual(changes, [4, 4, 4])
})
