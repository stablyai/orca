import { createConnection, type Socket } from 'node:net'
import {
  RUNTIME_LOCAL_STREAM_MAX_OUTBOUND_FRAME_BYTES,
  RUNTIME_LOCAL_STREAM_PROTOCOL,
  RUNTIME_LOCAL_STREAM_UPGRADE_METHOD,
  RuntimeLocalStreamFrameKind,
  createRuntimeLocalStreamFrameReader,
  encodeRuntimeLocalStreamFrame
} from '../../shared/runtime-local-stream-protocol'

export type LocalStreamTestClient = {
  socket: Socket
  upgradeResponse: Record<string, unknown>
  responses: Record<string, unknown>[]
  binaryFrames: Buffer[]
  sendRequest(request: Record<string, unknown>): void
  sendBinary(bytes: Uint8Array<ArrayBufferLike>): void
  closed: Promise<void>
  close(): void
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object frame')
  }
  return Object.fromEntries(Object.entries(value))
}

/** Opens a runtime socket, sends the upgrade line, and resolves once the runtime answered it. */
export async function openLocalStreamTestClient(
  endpoint: string,
  authToken: string,
  params: Record<string, unknown> = { protocol: RUNTIME_LOCAL_STREAM_PROTOCOL, versions: [1] }
): Promise<LocalStreamTestClient> {
  const socket = createConnection(endpoint)
  const responses: Record<string, unknown>[] = []
  const binaryFrames: Buffer[] = []
  const reader = createRuntimeLocalStreamFrameReader(
    {
      onText: (text) => responses.push(parseJsonObject(text)),
      onBinary: (bytes) => binaryFrames.push(bytes),
      onFatal: () => socket.destroy()
    },
    RUNTIME_LOCAL_STREAM_MAX_OUTBOUND_FRAME_BYTES
  )
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  const upgradeResponse = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let line = Buffer.alloc(0)
    let upgraded = false
    socket.once('error', reject)
    socket.on('data', (chunk: Buffer) => {
      if (upgraded) {
        reader.feed(chunk)
        return
      }
      line = Buffer.concat([line, chunk])
      const newline = line.indexOf(0x0a)
      if (newline === -1) {
        return
      }
      upgraded = true
      const response = parseJsonObject(line.toString('utf8', 0, newline))
      reader.feed(line.subarray(newline + 1))
      resolve(response)
    })
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ id: 'upgrade', authToken, method: RUNTIME_LOCAL_STREAM_UPGRADE_METHOD, params })}\n`
      )
    })
  })
  return {
    socket,
    upgradeResponse,
    responses,
    binaryFrames,
    sendRequest: (request) =>
      socket.write(
        encodeRuntimeLocalStreamFrame(RuntimeLocalStreamFrameKind.Text, JSON.stringify(request))
      ),
    sendBinary: (bytes) =>
      socket.write(encodeRuntimeLocalStreamFrame(RuntimeLocalStreamFrameKind.Binary, bytes)),
    closed,
    close: () => socket.destroy()
  }
}
