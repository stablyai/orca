const { test } = require('node:test')
const assert = require('node:assert/strict')
const { loadArkts } = require('./arkts-source.cjs')
const { createRpcPeer } = require('./fixtures/rpc-peer.cjs')

const offer = {
  endpoint: 'ws://desktop.invalid:6768',
  relay: {
    cellUrl: 'https://cell.invalid',
    directorUrl: 'https://director.invalid',
    relayHostId: 'test-host',
    inviteToken: 'test-invite'
  }
}

function createPairing() {
  const probes = new Map()
  const logSinks = new Map()
  const closed = new Set()
  let notifyProbes
  const ready = new Promise((resolve) => {
    notifyProbes = resolve
  })
  class RpcSuccess {}
  class SpikeRpcClient {
    path = 'direct'
    setLogSink(sink) {
      this.log = sink
    }
    configureRelay() {
      this.path = 'relay'
    }
    isRelay() {
      return this.path === 'relay'
    }
    authenticationRejected() {
      return false
    }
    async connect() {}
    request(method) {
      assert.equal(method, 'status.get')
      logSinks.set(this.path, this.log)
      return new Promise((resolve) => {
        probes.set(this.path, resolve)
        if (probes.size === 2) {
          notifyProbes()
        }
      })
    }
    close() {
      closed.add(this.path)
      probes.get(this.path)?.({ errorCode: 'closed' })
    }
    getRelayMove() {
      return null
    }
    getRelayCloseCode() {
      return 4403
    }
  }
  const { PairingConnection } = loadArkts('pairing/PairingConnection.ets', ['PairingConnection'], {
    SpikeRpcClient,
    RpcSuccess,
    relayConnectUrl: (origin) => origin
  })
  const connection = new PairingConnection()
  return { connection, probes, closed, RpcSuccess, ready, logSinks }
}

test('Relay can finish pairing while direct status is still pending', async () => {
  const { connection, probes, closed, RpcSuccess, ready, logSinks } = createPairing()
  const logs = []
  const selected = connection.connect(offer, (line) => logs.push(line))
  await ready
  probes.get('relay')(new RpcSuccess())
  assert.equal((await selected).client.isRelay(), true)
  assert.deepEqual([...closed], ['direct'])
  logSinks.get('direct')('late network error')
  logSinks.get('relay')('authenticated')
  connection.close()
  logSinks.get('relay')('late socket error')
  assert.deepEqual(logs, ['Relay: authenticated'])
})

test('a rejected status reply cannot beat an authenticated direct answer', async () => {
  const { connection, probes, closed, RpcSuccess, ready } = createPairing()
  const selected = connection.connect(offer, () => {})
  await ready
  probes.get('relay')({ errorCode: 'unauthorized' })
  probes.get('direct')(new RpcSuccess())
  assert.equal((await selected).client.isRelay(), false)
  assert.deepEqual([...closed], ['relay'])
  connection.close()
})

test('a revoked device is distinguished from an unsupported handshake', async () => {
  for (const authenticate of [true, false]) {
    const peer = createRpcPeer({ authenticate })
    const { PairingConnection } = loadArkts(
      'pairing/PairingConnection.ets',
      ['PairingConnection'],
      peer
    )
    const connection = new PairingConnection()
    const result = connection.connect({ ...offer, relay: null }, () => {})
    const expected = authenticate
      ? /desktop rejected the pairing code/
      : /pairing paths unavailable/
    const rejection = assert.rejects(result, expected)
    await Promise.resolve()
    peer.close(4001, authenticate ? 'Unauthorized' : 'Invalid e2ee_hello')
    await rejection
    connection.close()
  }
})

test('ticket exchange keeps compatible credentials and rejects unconfirmed ownership', async () => {
  const { toHex } = loadArkts('transport/crypto/Bytes.ets', ['toHex'])
  class RpcSuccess {
    constructor(result) {
      this.result = JSON.stringify(result)
    }
  }
  const { exchangePairingTicket } = loadArkts(
    'pairing/PairingConnection.ets',
    ['exchangePairingTicket'],
    {
      RpcSuccess,
      toHex,
      randomBytes: (length) => new Uint8Array(length).fill(7)
    }
  )
  const token = '070707070707070707070707070707070707070707070707'
  let persisted
  const remember = async (value) => {
    persisted = value
  }
  const connection = {
    status: null,
    client: {
      async request() {
        throw new Error('Unsupported legacy exchange')
      }
    }
  }
  assert.equal(
    await exchangePairingTicket(connection, 'original-ticket', () => {}, remember),
    'original-ticket'
  )
  connection.status = { capabilities: ['pairing.ticket-exchange.v1'] }
  connection.client.request = async (_method, params) => {
    assert.equal(persisted, token)
    assert.equal(JSON.parse(params).deviceToken, token)
    return { errorCode: 'not_supported' }
  }
  assert.equal(
    await exchangePairingTicket(connection, 'original-ticket', () => {}, remember),
    'original-ticket'
  )
  connection.client.request = async () => ({
    errorCode: 'runtime_error',
    errorMessage: 'ticket_window_closed'
  })
  assert.equal(
    await exchangePairingTicket(connection, 'original-ticket', () => {}, remember),
    'original-ticket'
  )
  for (const reply of [
    { errorCode: 'ticket_exchange_pending' },
    { errorCode: 'runtime_error', errorMessage: 'ticket_exchange_pending' },
    { errorCode: 'device_not_found' },
    { errorCode: 'runtime_error', errorMessage: 'device_not_found' }
  ]) {
    connection.client.request = async () => reply
    await assert.rejects(
      exchangePairingTicket(connection, 'original-ticket', () => {}, remember),
      /unresolved/
    )
    assert.equal(persisted, '070707070707070707070707070707070707070707070707')
  }
  connection.client.request = async () => ({
    errorCode: 'runtime_error',
    errorMessage: 'storage_unavailable'
  })
  await assert.rejects(
    exchangePairingTicket(connection, 'original-ticket', () => {}, remember),
    /unresolved/
  )
  connection.client.request = async () => new RpcSuccess(undefined)
  await assert.rejects(
    exchangePairingTicket(connection, 'original-ticket', () => {}, remember),
    /unresolved/
  )
  connection.client.request = async () => ({ errorCode: 'timeout' })
  await assert.rejects(
    exchangePairingTicket(connection, 'original-ticket', () => {}, remember),
    /unresolved/
  )
  connection.client.request = async () => {
    throw new Error('Reply lost')
  }
  await assert.rejects(
    exchangePairingTicket(connection, 'original-ticket', () => {}, remember),
    /Reply lost/
  )
  connection.client.request = async () => new RpcSuccess({ deviceId: 'confirmed-device' })
  assert.equal(
    await exchangePairingTicket(connection, 'original-ticket', () => {}, remember, token),
    token
  )
})
