import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { WebSocketTransport } from '../../src/main/runtime/rpc/ws-transport.ts'
import {
  WEBSOCKET_TRANSPORT_MAX_BACKPRESSURE_BYTES,
  WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES
} from '../../src/main/runtime/rpc/websocket-transport-limits.ts'

const TIMEOUT_MS = 5_000

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function openRawSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

export function waitForSocketClose(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for raw socket close')),
      TIMEOUT_MS
    )
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text)
  if (payload.byteLength >= 126) {
    throw new Error('The raw WebSocket smoke frame must use the short payload form')
  }
  const mask = randomBytes(4)
  const frame = Buffer.allocUnsafe(2 + mask.byteLength + payload.byteLength)
  frame[0] = 0x81
  frame[1] = 0x80 | payload.byteLength
  mask.copy(frame, 2)
  for (let index = 0; index < payload.byteLength; index += 1) {
    frame[6 + index] = payload[index] ^ mask[index % mask.byteLength]
  }
  return frame
}

async function openRawWebSocket(port) {
  const socket = await openRawSocket(port)
  const response = new Promise((resolve, reject) => {
    let headers = ''
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for raw WebSocket upgrade')),
      TIMEOUT_MS
    )
    const onData = (chunk) => {
      headers += chunk.toString('latin1')
      if (!headers.includes('\r\n\r\n')) {
        return
      }
      clearTimeout(timer)
      socket.off('data', onData)
      if (!headers.startsWith('HTTP/1.1 101')) {
        reject(new Error(`Raw WebSocket upgrade failed: ${headers.slice(0, 200)}`))
        return
      }
      resolve()
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
  const key = randomBytes(16).toString('base64')
  socket.write(
    [
      'GET / HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      ''
    ].join('\r\n')
  )
  await response
  return socket
}

export async function verifyNativeSendBackpressure() {
  const responseChunk = 'z'.repeat(WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES)
  const responseAttempts =
    Math.ceil(WEBSOCKET_TRANSPORT_MAX_BACKPRESSURE_BYTES / responseChunk.length) + 16
  let attemptedResponses = 0
  let closeCallbacks = 0
  let socket = null
  const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
  transport.onConnectionClose(() => {
    closeCallbacks += 1
  })
  transport.onMessage((message, reply, acceptedSocket) => {
    transport.setClientId(acceptedSocket, 'bun-websocket-backpressure-smoke')
    if (message !== 'flood') {
      return
    }
    for (let index = 0; index < responseAttempts; index += 1) {
      reply(responseChunk)
      attemptedResponses += 1
    }
  })
  await transport.start()
  try {
    socket = await openRawWebSocket(transport.resolvedPort)
    const closed = waitForSocketClose(socket)
    socket.write(maskedTextFrame('flood'))
    socket.pause()
    await delay(250)
    socket.resume()
    await closed
    await delay(10)
    if (attemptedResponses !== responseAttempts) {
      throw new Error(
        `Bun send-backpressure handler attempted ${attemptedResponses}/${responseAttempts} responses`
      )
    }
    if (closeCallbacks !== 1) {
      throw new Error(`Bun send backpressure produced ${closeCallbacks} close callbacks`)
    }
  } finally {
    socket?.destroy()
    await transport.stop()
  }
  return { attemptedResponses, closeCallbacks }
}
