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

test('incomplete pairing replies keep the authenticated path and the original ticket', async () => {
  const capability = 'pairing.ticket-exchange.v1'
  const { toHex } = loadArkts('transport/crypto/Bytes.ets', ['toHex'])
  for (const status of [undefined, { capabilities: [capability] }]) {
    const peer = createRpcPeer()
    const { PairingConnection, exchangePairingTicket } = loadArkts(
      'pairing/PairingConnection.ets',
      ['PairingConnection', 'exchangePairingTicket'],
      { ...peer, toHex, randomBytes: (length) => new Uint8Array(length).fill(7) }
    )
    function reply(method, result) {
      const request = peer.sent
        .map((frame) => JSON.parse(frame))
        .findLast((frame) => frame.method === method)
      assert.ok(request, `Expected ${method}`)
      peer.receiveText(JSON.stringify({ id: request.id, ok: true, result }))
    }
    const connection = new PairingConnection()
    const selecting = connection.connect({ ...offer, relay: null }, () => {})
    await new Promise(setImmediate)
    reply('status.get', status)
    const selected = await selecting
    if (status === undefined) {
      assert.equal(selected.status, null)
      assert.equal(
        await exchangePairingTicket(selected, 'original-ticket', () => {}),
        'original-ticket'
      )
    } else {
      const incomplete = exchangePairingTicket(selected, 'original-ticket', () => {})
      reply('pairing.exchangeTicket', undefined)
      assert.equal(await incomplete, 'original-ticket')

      const confirmed = exchangePairingTicket(selected, 'original-ticket', () => {})
      reply('pairing.exchangeTicket', { deviceId: 'confirmed-device' })
      assert.equal(await confirmed, '070707070707070707070707070707070707070707070707')
    }
    connection.close()
  }
})
