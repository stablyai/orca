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
    [
      'retainDesktopConnection',
      'refreshDesktopConnection',
      'forgetDesktopConnection',
      'closeIdleDesktopConnections',
      'reconcileHomeDesktopConnections'
    ],
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
  const shell = retainDesktopConnection({}, 'alpha', 'explicit')
  const diagnostics = retainDesktopConnection({}, 'alpha', 'explicit')
  home.connection.connect()
  other.connection.connect()
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

test('an offline automation list stays with its pairing and ignores a replaced connection', async () => {
  const profile = { id: 'alpha', endpoint: 'ws://alpha.invalid:6768', lastConnected: 1 }
  const { retainDesktopConnection, refreshDesktopConnection } = loadDesktopConnections([profile])
  const { connection, release } = retainDesktopConnection({}, 'alpha', 'explicit')
  try {
    const first = await waitForPhase(connection, 'connected')
    connection.rememberAutomationCatalog(first, '{"automations":[],"items":[]}')
    connection.disconnect()
    assert.equal(connection.getAutomationCatalog(profile)?.result, '{"automations":[],"items":[]}')
    assert.equal(connection.getAutomationCatalog({ ...profile, id: 'beta' }), null)

    profile.lastConnected = 2
    refreshDesktopConnection('alpha', 'paired')
    await waitForPhase(connection, 'connected')
    connection.rememberAutomationCatalog(first, '{"automations":[],"items":[]}')
    assert.equal(connection.getAutomationCatalog(profile), null)
  } finally {
    release()
  }
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

test('Home fills automatic slots with readable pairings and keeps a manual disconnect on reselection', async () => {
  const hosts = [
    ['unpaired', 50],
    ['locked', 40],
    ['alpha', 30],
    ['beta', 20],
    ['gamma', 10]
  ].map(([id, lastConnected]) => ({
    id,
    lastConnected,
    endpoint: `ws://${id}.invalid:6768`,
    publicKeyB64: 'test-key'
  }))
  let unlocked = false
  const { retainDesktopConnection, reconcileHomeDesktopConnections } = loadDesktopConnections(
    hosts,
    async (_context, id) => {
      if (id === 'unpaired') {
        return null
      }
      if (id === 'locked' && !unlocked) {
        throw new Error('Credential store is locked')
      }
      return 'test-token'
    }
  )
  const leases = hosts.map((host) => retainDesktopConnection({}, host.id))
  const candidates = hosts.map((host, index) => ({ host, connection: leases[index].connection }))
  const [, locked, alpha, beta, gamma] = leases.map((lease) => lease.connection)
  const connectedIds = () =>
    candidates.filter(({ connection }) => connection.getClient()).map(({ host }) => host.id)
  const current = () => true
  try {
    await reconcileHomeDesktopConnections(candidates, current)
    await Promise.all(
      [alpha, beta, gamma].map((connection) => waitForPhase(connection, 'connected'))
    )
    assert.deepEqual(connectedIds(), ['alpha', 'beta', 'gamma'])
    assert.equal(leases[0].connection.getCredentialStatus(), 'missing')
    assert.equal(locked.getCredentialStatus(), 'temporarily-unavailable')

    const previous = gamma.getClient()
    unlocked = true
    await reconcileHomeDesktopConnections(candidates, current)
    await waitForPhase(locked, 'connected')
    assert.deepEqual(connectedIds(), ['locked', 'alpha', 'beta'])
    assert.equal(previous.closed, true)

    const manual = alpha.getClient()
    alpha.disconnect()
    await reconcileHomeDesktopConnections(candidates, current)
    assert.deepEqual(connectedIds(), ['locked', 'beta'])
    assert.equal(manual.closed, true)
  } finally {
    leases.forEach((lease) => lease.release())
  }
})

test('releasing a settings connection leaves only desktops that still have connection demand', async () => {
  const hosts = ['recent', 'older', 'manual'].map((id) => ({
    id,
    endpoint: `ws://${id}.invalid:6768`
  }))
  const { retainDesktopConnection } = loadDesktopConnections(hosts)
  const recent = retainDesktopConnection({}, 'recent')
  const older = retainDesktopConnection({}, 'older')
  const manual = retainDesktopConnection({}, 'manual')
  recent.connection.setHomeAutoConnect(true)
  older.connection.setHomeAutoConnect(true)
  manual.connection.connect(true)
  const recentSettings = retainDesktopConnection({}, 'recent', 'automatic')
  const manualSettings = retainDesktopConnection({}, 'manual', 'automatic')
  const firstSettings = retainDesktopConnection({}, 'older', 'automatic')
  const secondSettings = retainDesktopConnection({}, 'older', 'automatic')
  try {
    const [recentClient, olderClient, manualClient] = await Promise.all(
      [recent, older, manual].map(({ connection }) => waitForPhase(connection, 'connected'))
    )
    older.connection.setHomeAutoConnect(false)
    assert.equal(older.connection.getClient(), olderClient)
    firstSettings.release()
    assert.equal(older.connection.getClient(), olderClient)
    secondSettings.release()
    assert.equal(older.connection.getClient(), null)
    assert.equal(olderClient.closed, true)
    recentSettings.release()
    manualSettings.release()
    assert.equal(recent.connection.getClient(), recentClient)
    assert.equal(manual.connection.getClient(), manualClient)
  } finally {
    for (const lease of [
      recentSettings,
      manualSettings,
      firstSettings,
      secondSettings,
      recent,
      older,
      manual
    ]) {
      lease.release()
    }
  }
})

test('Home closes a displaced desktop when its workspace and diagnostics no longer hold it', async () => {
  const hosts = [{ id: 'older', endpoint: 'ws://older.invalid:6768' }]
  const { retainDesktopConnection, closeIdleDesktopConnections } = loadDesktopConnections(hosts)
  const home = retainDesktopConnection({}, 'older')
  const workspace = retainDesktopConnection({}, 'older', 'explicit')
  const diagnostics = retainDesktopConnection({}, 'older', 'explicit')
  try {
    const client = await waitForPhase(home.connection, 'connected')
    home.connection.setHomeAutoConnect(true)
    home.connection.setHomeAutoConnect(false)
    assert.equal(home.connection.getClient(), client)
    workspace.release(true)
    home.connection.setHomeAutoConnect(false)
    assert.equal(home.connection.getClient(), client)
    diagnostics.release(true)
    assert.equal(home.connection.getClient(), client)
    closeIdleDesktopConnections()
    assert.equal(home.connection.getClient(), null)
    assert.equal(client.closed, true)
  } finally {
    workspace.release()
    diagnostics.release()
    home.release()
  }
})
