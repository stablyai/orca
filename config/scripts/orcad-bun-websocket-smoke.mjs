#!/usr/bin/env bun

import { WebSocketTransport } from '../../src/main/runtime/rpc/ws-transport.ts'
import {
  WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES,
  WEBSOCKET_TRANSPORT_MAX_TCP_CONNECTIONS
} from '../../src/main/runtime/rpc/websocket-transport-limits.ts'
import {
  evaluateOrcadBunSoakBudget,
  parseOrcadBunSoakOptions,
  sampleOrcadBunSoakResources
} from './orcad-bun-soak-budget.mjs'
import {
  openRawSocket,
  verifyNativeSendBackpressure,
  waitForSocketClose
} from './orcad-bun-websocket-backpressure-smoke.mjs'

const HEARTBEAT_INTERVAL_MS = 25
const TIMEOUT_MS = 5_000
const options = parseOrcadBunSoakOptions(process.argv.slice(2))

function waitForEvent(target, name, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for WebSocket ${name}`)),
      timeoutMs
    )
    target.addEventListener(
      name,
      (event) => {
        clearTimeout(timer)
        resolve(event)
      },
      { once: true }
    )
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function rawServer(port = 0) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: () => new Response('occupied')
  })
}

async function verifyPortFallback() {
  const holder = rawServer()
  const reservation = rawServer()
  const fallbackPort = reservation.port
  await reservation.stop(true)
  const transport = new WebSocketTransport({
    host: '127.0.0.1',
    port: holder.port,
    fallbackPort,
    preferPinnedPort: true
  })
  transport.onMessage(() => {})
  transport.onConnectionClose(() => {})
  try {
    await transport.start()
    if (transport.resolvedPort !== fallbackPort) {
      throw new Error(
        `Bun WebSocket fallback bound ${transport.resolvedPort}, expected ${fallbackPort}`
      )
    }
  } finally {
    await transport.stop()
    await holder.stop(true)
  }
}

async function verifyRawTcpCap() {
  const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
  transport.onMessage(() => {})
  transport.onConnectionClose(() => {})
  await transport.start()
  const admitted = []
  try {
    for (let index = 0; index < WEBSOCKET_TRANSPORT_MAX_TCP_CONNECTIONS; index += 1) {
      admitted.push(await openRawSocket(transport.resolvedPort))
    }
    const overflow = await openRawSocket(transport.resolvedPort)
    await waitForSocketClose(overflow)
    if (admitted.some((socket) => socket.destroyed)) {
      throw new Error('Bun raw TCP cap displaced an admitted connection')
    }
  } finally {
    for (const socket of admitted) {
      socket.destroy()
    }
    await transport.stop()
  }
}

async function verifySocketContract() {
  let acceptedMessages = 0
  let bufferedAmountType = 'missing'
  const transport = new WebSocketTransport({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    preAuthTimeoutMs: TIMEOUT_MS
  })
  transport.onConnectionClose(() => {})
  transport.onMessage((message, reply, socket) => {
    acceptedMessages += 1
    bufferedAmountType = typeof socket.bufferedAmount
    transport.setClientId(socket, 'bun-websocket-smoke')
    if (message === 'hello') {
      reply('ack')
    }
  })
  await transport.start()
  try {
    const url = `ws://127.0.0.1:${transport.resolvedPort}`
    const client = new WebSocket(url)
    await waitForEvent(client, 'open')
    const ack = waitForEvent(client, 'message')
    client.send('hello')
    const ackEvent = await ack
    if (ackEvent.data !== 'ack' || bufferedAmountType !== 'number') {
      throw new Error(
        `Bun WebSocket adapter mismatch: ack=${String(ackEvent.data)} bufferedAmount=${bufferedAmountType}`
      )
    }
    await delay(HEARTBEAT_INTERVAL_MS * 5)
    if (client.readyState !== WebSocket.OPEN) {
      throw new Error('Bun WebSocket heartbeat reaped an auto-ponging live client')
    }
    const clientClosed = waitForEvent(client, 'close')
    client.close()
    await clientClosed

    const oversized = new WebSocket(url)
    await waitForEvent(oversized, 'open')
    const oversizedClosed = waitForEvent(oversized, 'close')
    oversized.send('x'.repeat(WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES + 100))
    await oversizedClosed
    if (acceptedMessages !== 1) {
      throw new Error(
        `Oversized Bun WebSocket payload reached the handler (${acceptedMessages} messages)`
      )
    }
  } finally {
    await transport.stop()
  }
  return { acceptedMessages, bufferedAmountType }
}

await verifyPortFallback()
await verifyRawTcpCap()
const samples = []
let acceptedMessages = 0
let attemptedResponses = 0
let bufferedAmountType = 'missing'
for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
  const contract = await verifySocketContract()
  const backpressure = await verifyNativeSendBackpressure()
  acceptedMessages += contract.acceptedMessages
  attemptedResponses += backpressure.attemptedResponses
  bufferedAmountType = contract.bufferedAmountType
  samples.push(await sampleOrcadBunSoakResources(cycle))
  if (options.cycles > 10 && cycle % 10 === 0) {
    process.stderr.write(`[orcad-bun-websocket] completed ${cycle}/${options.cycles} cycles\n`)
  }
}
const resources = evaluateOrcadBunSoakBudget(samples, options.maxRssGrowthBytes)
const ok = resources.failures.length === 0
console.log(
  JSON.stringify({
    ok,
    runtime: `bun ${Bun.version}`,
    cycles: options.cycles,
    checks: [
      'fallback-port',
      'raw-tcp-cap',
      'buffered-amount',
      'pong-heartbeat',
      'inbound-payload-bound',
      'native-send-backpressure',
      'repeated-teardown-resource-budget'
    ],
    acceptedMessages,
    attemptedResponses,
    bufferedAmountType,
    resources
  })
)
if (!ok) {
  process.exit(1)
}
