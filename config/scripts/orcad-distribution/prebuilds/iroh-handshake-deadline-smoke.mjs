#!/usr/bin/env node
// Run after build:orcad-prebuilds. --native <addon.node> also permits an explicit stock-SDK comparison.
// Wall-clock integration: the Rust timer cannot be advanced by JavaScript fake timers.
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { IROH_BUILD_IDENTITY, verifyIrohPrebuild } from './iroh-prebuild.mjs'
import { readManifest } from './orcad-prebuild-slot-contents.mjs'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../../../..')
const nativeIndex = process.argv.indexOf('--native')
const slot = `${process.platform}-${process.arch}${process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? '-glibc' : '-musl') : ''}`
const prebuildsDir = process.env.ORCAD_PREBUILDS_DIR || join(root, 'out', 'orcad-prebuilds')
if (nativeIndex !== -1 && !process.argv[nativeIndex + 1]) {
  throw new Error('--native requires an explicit native addon path')
}
const native =
  nativeIndex !== -1
    ? resolve(process.argv[nativeIndex + 1])
    : verifyIrohPrebuild({
        slotDir: join(prebuildsDir, slot),
        slot,
        entry: readManifest(prebuildsDir)?.slots?.[slot],
        version: IROH_BUILD_IDENTITY.sdkVersion
      })
const { Accepting, Endpoint, EndpointAddr } = require(native)
if (nativeIndex === -1) {
  assert.equal(
    Accepting.incomingHandshakeTimeoutMs?.(),
    10_000,
    'qualified native must expose its enforced deadline before binding'
  )
}
const alpn = Array.from(Buffer.from('orca/handshake-deadline-smoke/1'))
const endpoints = []
const proxies = []
const connections = []

/** Bound the smoke itself so an unpatched native future fails rather than hanging its runner. */
async function within(promise, milliseconds, label) {
  const deadline = Promise.withResolvers()
  const timer = setTimeout(() => deadline.reject(new Error(label)), milliseconds)
  try {
    return await Promise.race([promise, deadline.promise])
  } finally {
    clearTimeout(timer)
  }
}

/** Bind real native endpoints without relay or discovery, keeping the regression loopback-only. */
async function bind() {
  const builder = Endpoint.builder()
  builder.applyMinimal()
  builder.bindAddr('127.0.0.1:0')
  builder.alpns([alpn])
  const endpoint = await builder.bind()
  endpoints.push(endpoint)
  return endpoint
}

/** Forward client Initial packets while withholding server replies, then replay the late handshake. */
async function stalledRoute(server) {
  const target = server.boundSockets().find((address) => address.startsWith('127.0.0.1:'))
  assert.ok(target, 'server must expose its loopback UDP socket')
  const port = Number(target.slice(target.lastIndexOf(':') + 1))
  const socket = createSocket('udp4')
  const errors = []
  socket.on('error', (error) => errors.push(error))
  socket.bind(0, '127.0.0.1')
  await once(socket, 'listening')
  let client
  let released = false
  let buffered = []
  socket.on('message', (packet, peer) => {
    if (peer.port === port) {
      if (released && client) {
        socket.send(packet, client.port, client.address)
      } else {
        // A stalled handshake retransmits; retain a bounded replay window for the late-result check.
        buffered.push(Buffer.from(packet))
        if (buffered.length > 64) {
          buffered.shift()
        }
      }
    } else {
      client = peer
      socket.send(packet, port, '127.0.0.1')
    }
  })
  const route = {
    addr: new EndpointAddr(server.id(), null, [`127.0.0.1:${socket.address().port}`]),
    /** Replay withheld handshake packets only after the native deadline has settled. */
    release() {
      assert.ok(client, 'the proxy must have received a real client Initial')
      assert.ok(buffered.length > 0, 'the server must have sent real handshake packets')
      released = true
      for (const packet of buffered) {
        socket.send(packet, client.port, client.address)
      }
      buffered = []
    },
    close() {
      socket.close()
      assert.deepEqual(errors, [], 'loopback proxy must not conceal UDP errors')
    }
  }
  proxies.push(route)
  return route
}

/** Observe real connection failure without leaving an unhandled client-side rejection. */
function dial(client, address) {
  return client.connect(address, alpn).then(
    (connection) => {
      connections.push(connection)
      return { connection }
    },
    (error) => ({ error })
  )
}

try {
  const server = await bind()
  const retainedPeer = await bind()
  const retainedDial = dial(
    retainedPeer,
    new EndpointAddr(
      server.id(),
      null,
      server.boundSockets().filter((address) => address.startsWith('127.0.0.1:'))
    )
  )
  const retainedIncoming = await within(
    server.acceptNext(),
    5_000,
    'existing healthy peer did not arrive before the stalled handshake'
  )
  assert.ok(retainedIncoming)
  const retainedConnection = await within(
    (await retainedIncoming.accept()).connect(),
    5_000,
    'existing healthy peer did not complete its handshake'
  )
  connections.push(retainedConnection)
  const retainedRemote = await within(
    retainedDial,
    5_000,
    'existing healthy peer could not connect'
  )
  assert.ok(retainedRemote.connection)
  const client = await bind()
  const route = await stalledRoute(server)
  const dialing = dial(client, route.addr)
  const incoming = await within(
    server.acceptNext(),
    5_000,
    'proxy did not deliver an incoming handshake'
  )
  assert.ok(incoming)
  const accepting = await incoming.accept()
  const started = performance.now()
  let published = 0
  const completed = accepting.connect().then(
    (connection) => {
      connections.push(connection)
      published += 1
      return { connection }
    },
    (error) => ({ error })
  )
  const expired = await within(
    completed,
    15_000,
    'native handshake exceeded its ten-second wall-clock deadline'
  )
  assert.ok(
    expired.error,
    'a stalled native handshake must reject rather than publish a connection'
  )
  assert.ok(
    performance.now() - started >= 9_000,
    'native deadline must not reject ordinary handshakes immediately'
  )
  assert.equal(published, 0)
  assert.equal(retainedConnection.closeReason(), null, 'timeout must not close an existing peer')
  assert.equal(
    retainedRemote.connection.closeReason(),
    null,
    'timeout must not close the existing peer remotely'
  )

  route.release()
  const late = await within(
    dialing,
    5_000,
    'timed-out native handshake remained live after late packets'
  )
  if (late.connection) {
    await within(late.connection.closed(), 5_000, 'late handshake did not receive native close')
    assert.ok(late.connection.closeReason())
  }
  assert.equal(published, 0, 'late handshake must never publish a server Connection')

  // Reuse the same server, proving timeout did not reset the endpoint or prevent new authenticated peers.
  const healthy = await bind()
  const accepted = server.acceptNext().then(async (next) => {
    assert.ok(next)
    const connection = await (await next.accept()).connect()
    connections.push(connection)
    return connection
  })
  const healthyDial = dial(
    healthy,
    new EndpointAddr(
      server.id(),
      null,
      server.boundSockets().filter((address) => address.startsWith('127.0.0.1:'))
    )
  )
  const healthyConnection = await within(
    accepted,
    5_000,
    'server did not accept a healthy replacement peer'
  )
  assert.ok(healthyConnection.remoteId().equals(healthy.id()))
  assert.ok((await within(healthyDial, 5_000, 'healthy peer could not connect')).connection)

  const stoppingClient = await bind()
  const stoppingRoute = await stalledRoute(server)
  const stoppingDial = dial(stoppingClient, stoppingRoute.addr)
  const stoppingIncoming = await within(
    server.acceptNext(),
    5_000,
    'shutdown handshake did not arrive'
  )
  assert.ok(stoppingIncoming)
  const stopping = (await stoppingIncoming.accept()).connect().then(
    (connection) => {
      connections.push(connection)
      return { connection }
    },
    (error) => ({ error })
  )
  await within(server.close(), 5_000, 'endpoint shutdown did not complete')
  assert.ok((await within(stopping, 5_000, 'shutdown left a native handshake pending')).error)
  await stoppingClient.close()
  await within(stoppingDial, 5_000, 'shutdown left a client dial pending')
  assert.equal(published, 0)
  console.log('Iroh native handshake deadline, late cleanup, replacement peer, and shutdown passed')
} finally {
  for (const connection of connections) {
    connection.close(0n, [])
  }
  await Promise.all(endpoints.map((endpoint) => endpoint.close()))
  for (const proxy of proxies) {
    proxy.close()
  }
}
