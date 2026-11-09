const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts } = require('./arkts-source.cjs')

function loadDesktopConnections(hosts, getDeviceToken = async () => 'test-token') {
  class HostSession {
    constructor(meta) {
      this.client = { endpoint: meta.endpoint, closed: false }
    }
    addListener(listener) {
      this.listener = listener
      return () => {
        this.listener = null
      }
    }
    getClient() {
      return this.client
    }
    getConnectedAt() {
      return 1000
    }
    getActivePath() {
      return 'lan'
    }
    start() {
      this.listener('connected', '')
    }
    stop() {
      this.client.closed = true
    }
  }
  class DesktopNotifications {
    attach() {}
    stop() {}
  }
  return loadArkts(
    'transport/DesktopConnections.ets',
    ['retainDesktopConnection', 'refreshDesktopConnection', 'forgetDesktopConnection'],
    {
      HostSession,
      DesktopNotifications,
      listHosts: async () => hosts.map((host) => ({ ...host })),
      getDeviceToken,
      getRelayCredential: async () => null
    }
  )
}

function waitForPhase(connection, target) {
  return new Promise((resolve) => {
    const unsubscribe = connection.observe((phase) => {
      if (phase === target) {
        queueMicrotask(() => unsubscribe())
        resolve(connection.getClient())
      }
    })
  })
}

test('page transitions keep the desktop channel and an address edit replaces only its owner', async () => {
  const hosts = [
    { id: 'alpha', endpoint: 'ws://alpha.invalid:6768', lastConnected: 1 },
    { id: 'beta', endpoint: 'ws://beta.invalid:6768', lastConnected: 2 }
  ]
  const { retainDesktopConnection, refreshDesktopConnection, forgetDesktopConnection } =
    loadDesktopConnections(hosts)
  const home = retainDesktopConnection({}, 'alpha')
  const other = retainDesktopConnection({}, 'beta')
  const shell = retainDesktopConnection({}, 'alpha')
  const diagnostics = retainDesktopConnection({}, 'alpha')
  home.connection.connect()
  other.connection.connect()
  shell.connection.connect(true)
  const [alpha, beta] = await Promise.all([
    waitForPhase(home.connection, 'connected'),
    waitForPhase(other.connection, 'connected')
  ])
  assert.equal(shell.connection.getClient(), alpha)
  assert.equal(diagnostics.connection.getClient(), alpha)
  shell.release()
  diagnostics.release()
  assert.equal(alpha.closed, false)

  hosts[0].endpoint = 'ws://alpha-updated.invalid:6768'
  refreshDesktopConnection('alpha', 'endpoint')
  const edited = await waitForPhase(home.connection, 'connected')
  assert.equal(edited.endpoint, 'ws://alpha-updated.invalid:6768')
  assert.equal(alpha.closed, true)
  assert.equal(other.connection.getClient(), beta)
  assert.equal(beta.closed, false)

  forgetDesktopConnection('alpha')
  assert.equal(home.connection.getClient(), null)
  assert.equal(edited.closed, true)
  assert.equal(other.connection.getClient(), beta)
  home.release()
  other.release()
  assert.equal(beta.closed, true)
})

test('an unreadable device credential remains retryable while a missing credential requires pairing', async () => {
  const hosts = [
    { id: 'locked', endpoint: 'ws://locked.invalid:6768', lastConnected: 1 },
    { id: 'missing', endpoint: 'ws://missing.invalid:6768', lastConnected: 2 }
  ]
  let unlocked = false
  const { retainDesktopConnection } = loadDesktopConnections(hosts, async (_context, id) => {
    if (id === 'missing') {
      return null
    }
    if (!unlocked) {
      throw new Error('Credential store is locked')
    }
    return 'test-token'
  })
  const locked = retainDesktopConnection({}, 'locked')
  const missing = retainDesktopConnection({}, 'missing')
  locked.connection.connect()
  missing.connection.connect()
  assert.equal(await waitForPhase(locked.connection, 'stopped'), null)
  assert.equal(await waitForPhase(missing.connection, 'auth-failed'), null)
  assert.equal(locked.connection.getCredentialStatus(), 'temporarily-unavailable')
  assert.equal(missing.connection.getCredentialStatus(), 'missing')

  unlocked = true
  locked.connection.connect(true)
  assert.equal(locked.connection.getCredentialStatus(), 'temporarily-unavailable')
  const client = await waitForPhase(locked.connection, 'connected')
  assert.equal(client.endpoint, 'ws://locked.invalid:6768')
  assert.equal(locked.connection.getCredentialStatus(), 'ready')
  locked.release()
  missing.release()
})
