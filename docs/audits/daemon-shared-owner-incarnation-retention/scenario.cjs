const assert = require('node:assert/strict')
const path = require('node:path')

function identity(epoch, pid) {
  return { pid, startedAtMs: epoch + 1, launchNonce: `daemon-${pid}-${epoch}` }
}
function makeAdapter(api, name, pid) {
  const adapter = new api.DaemonPtyAdapter({
    socketPath: path.join(__dirname, `${name}.sock`),
    tokenPath: path.join(__dirname, `${name}.token`)
  })
  let sessions = []
  const requests = []
  adapter.client.daemonIdentity = identity(0, pid)
  // Only the authenticated transport ports are inert; inventory and identity publication are actual methods.
  adapter.client.ensureConnected = async () => {}
  adapter.client.ensureConnectedWithin = async () => {}
  adapter.client.request = async (type, payload) => {
    requests.push(type)
    if (type === 'listSessions') {
      return { sessions }
    }
    assert.equal(type, 'createOrAttach')
    assert.equal(payload.attachOnly, true)
    const found = sessions.find((item) => item.sessionId === payload.sessionId)
    assert(found)
    return {
      isNew: false,
      snapshot: null,
      pid: found.pid,
      incarnationId: found.incarnationId,
      shellState: 'unsupported'
    }
  }
  return {
    adapter,
    requests,
    setSessions(value) {
      sessions = value
    },
    publishIdentity(epoch) {
      adapter.client.daemonIdentity = identity(epoch, pid)
      return adapter.establishLifecycleLease()
    }
  }
}
function session(id, incarnationId) {
  return {
    sessionId: id,
    incarnationId,
    isAlive: true,
    pid: 999999999,
    cwd: '/fixture',
    cols: 80,
    rows: 24
  }
}
async function exercise(api, phase) {
  const current = makeAdapter(api, 'current', 999999997)
  const legacy = makeAdapter(api, 'legacy', 999999998)
  const fallback = {
    onData: () => () => {},
    onExit: () => () => {},
    hasPty: () => false,
    listProcesses: async () => []
  }
  const provider = new api.DegradedDaemonPtyProvider({
    current: current.adapter,
    legacy: [legacy.adapter],
    fallback
  })
  const recovery = provider.ownerRecovery
  const attach = recovery.attachResolver
  const liveness = recovery.livenessResolver
  const rows = []
  try {
    await current.publishIdentity(0)
    await legacy.publishIdentity(0)
    legacy.setSessions([session('legacy-live', 'legacy-incarnation')])
    for (let cycle = 0; cycle < 32; cycle++) {
      const id = `current-${cycle}`
      current.setSessions([session(id, `incarnation-${cycle}`)])
      // Public discovery populates attach authority; public liveness fills the other resolver.
      await provider.discoverDaemonSessions()
      assert.equal(await provider.probePtyLiveness(`unmapped-probe-${cycle}`), false)
      assert.equal(attach.routeIncarnations.get(id), `incarnation-${cycle}`)
      assert.equal(liveness.routeIncarnations.get(id), `incarnation-${cycle}`)
      assert.equal(provider.sessionProviders.get(id), current.adapter)
      const beforeDuplicate = liveness.routeIncarnations.size
      await current.publishIdentity(cycle)
      assert.equal(liveness.routeIncarnations.size, beforeDuplicate)
      // A new authenticated identity retires the old daemon's routes through actual listeners.
      current.setSessions([])
      await current.publishIdentity(cycle + 1)
      assert.equal(provider.sessionProviders.has(id), false)
      assert.equal(attach.routeIncarnations.has(id), false)
      assert.equal(liveness.routeIncarnations.has(id), phase === 'before')
      assert.equal(provider.sessionProviders.get('legacy-live'), legacy.adapter)
      assert.equal(attach.routeIncarnations.get('legacy-live'), 'legacy-incarnation')
      assert.equal(liveness.routeIncarnations.get('legacy-live'), 'legacy-incarnation')
      rows.push({
        cycle,
        sharedRoutes: provider.sessionProviders.size,
        attachEntries: attach.routeIncarnations.size,
        livenessEntries: liveness.routeIncarnations.size
      })
    }
    assert.equal(provider.sessionProviders.size, 1)
    assert.equal(attach.routeIncarnations.size, 1)
    assert.equal(liveness.routeIncarnations.size, phase === 'before' ? 33 : 1)
    legacy.adapter.client.eventListeners.each((listener) =>
      listener({
        type: 'event',
        event: 'exit',
        sessionId: 'legacy-live',
        payload: { code: 0, incarnationId: 'legacy-incarnation' }
      })
    )
    assert.equal(provider.sessionProviders.size, 0)
    assert.equal(attach.routeIncarnations.size, 0)
    assert.equal(liveness.routeIncarnations.size, phase === 'before' ? 32 : 0)
    const afterLegacyExit = {
      sharedRoutes: provider.sessionProviders.size,
      attachEntries: attach.routeIncarnations.size,
      livenessEntries: liveness.routeIncarnations.size
    }
    legacy.setSessions([])
    current.setSessions([session('same-id', 'old-incarnation')])
    await provider.discoverDaemonSessions()
    await provider.probePtyLiveness('unmapped-old')
    current.setSessions([])
    legacy.setSessions([session('same-id', 'new-incarnation')])
    await provider.discoverDaemonSessions()
    await provider.probePtyLiveness('unmapped-new')
    await current.publishIdentity(33)
    assert.equal(provider.sessionProviders.get('same-id'), legacy.adapter)
    assert.equal(attach.routeIncarnations.get('same-id'), 'new-incarnation')
    assert.equal(liveness.routeIncarnations.get('same-id'), 'new-incarnation')
    current.requests.length = 0
    legacy.requests.length = 0
    const attached = await provider.spawn({
      sessionId: 'same-id',
      attachOnly: true,
      cols: 80,
      rows: 24,
      expectedIncarnationId: 'new-incarnation',
      expectedIncarnationIsAuthoritative: true
    })
    assert.equal(attached.id, 'same-id')
    assert.equal(attached.incarnationId, 'new-incarnation')
    assert.equal(attached.isReattach, true)
    assert.deepEqual(current.requests, [])
    assert.deepEqual(legacy.requests, ['createOrAttach'])
    await assert.rejects(
      provider.spawn({
        sessionId: 'same-id',
        attachOnly: true,
        cols: 80,
        rows: 24,
        expectedIncarnationId: 'retired-incarnation',
        expectedIncarnationIsAuthoritative: true
      }),
      { name: 'TerminalSessionOwnerUnverifiedError' }
    )
    assert.equal(legacy.requests.filter((type) => type === 'createOrAttach').length, 1)
    return {
      cycles: 32,
      rows,
      afterLegacyExit,
      sameIdSuccessorPreserved: true,
      matchingDirectAttachWithoutInventory: true,
      authoritativeIncarnationMismatchRefused: true,
      unchangedIdentityPreserved: true,
      otherLiveProviderPreserved: true,
      ordinaryExitRetiresBoth: true
    }
  } finally {
    provider.dispose()
  }
}

module.exports = { exercise }
