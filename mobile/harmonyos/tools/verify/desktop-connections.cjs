const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts } = require('./arkts-source.cjs')

test('page transitions keep the desktop channel and an address edit replaces only its owner', async () => {
  const hosts = [
    { id: 'alpha', endpoint: 'ws://alpha.invalid:6768', lastConnected: 1 },
    { id: 'beta', endpoint: 'ws://beta.invalid:6768', lastConnected: 2 }
  ]
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
  const { retainDesktopConnection, refreshDesktopConnection, forgetDesktopConnection } = loadArkts(
    'transport/DesktopConnections.ets',
    ['retainDesktopConnection', 'refreshDesktopConnection', 'forgetDesktopConnection'],
    {
      HostSession,
      DesktopNotifications,
      listHosts: async () => hosts.map((host) => ({ ...host })),
      getDeviceToken: async () => 'test-token',
      getRelayCredential: async () => null
    }
  )
  function connected(connection) {
    return new Promise((resolve) => {
      let unsubscribe
      unsubscribe = connection.observe((phase) => {
        if (phase === 'connected') {
          queueMicrotask(() => unsubscribe())
          resolve(connection.getClient())
        }
      })
    })
  }
  const home = retainDesktopConnection({}, 'alpha')
  const other = retainDesktopConnection({}, 'beta')
  const shell = retainDesktopConnection({}, 'alpha')
  const diagnostics = retainDesktopConnection({}, 'alpha')
  home.connection.connect()
  other.connection.connect()
  shell.connection.connect(true)
  const [alpha, beta] = await Promise.all([connected(home.connection), connected(other.connection)])
  assert.equal(shell.connection.getClient(), alpha)
  assert.equal(diagnostics.connection.getClient(), alpha)
  shell.release()
  diagnostics.release()
  assert.equal(alpha.closed, false)

  hosts[0].endpoint = 'ws://alpha-updated.invalid:6768'
  refreshDesktopConnection('alpha', 'endpoint')
  const edited = await connected(home.connection)
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
