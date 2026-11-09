const { test } = require('node:test')
const assert = require('node:assert/strict')
const { loadArkts } = require('./arkts-source.cjs')

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
  const closed = new Set()
  let notifyProbes
  const ready = new Promise((resolve) => {
    notifyProbes = resolve
  })
  class RpcSuccess {}
  class SpikeRpcClient {
    path = 'direct'
    setLogSink() {}
    configureRelay() {
      this.path = 'relay'
    }
    isRelay() {
      return this.path === 'relay'
    }
    async connect() {}
    request(method) {
      assert.equal(method, 'status.get')
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
  return { connection, probes, closed, RpcSuccess, ready }
}

test('Relay can finish pairing while direct status is still pending', async () => {
  const { connection, probes, closed, RpcSuccess, ready } = createPairing()
  const selected = connection.connect(offer, () => {})
  await ready
  probes.get('relay')(new RpcSuccess())
  assert.equal((await selected).client.isRelay(), true)
  assert.deepEqual([...closed], ['direct'])
  connection.close()
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
