import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SonioxTranscriptionSession } from './soniox-transcription-client'

function listen(server: WebSocketServer): Promise<number> {
  return new Promise((resolve) => {
    server.once('listening', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Expected an IP WebSocket test address')
      }
      resolve(address.port)
    })
  })
}

describe('Soniox WebSocket protocol integration', () => {
  const servers: WebSocketServer[] = []

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
          })
      )
    )
  })

  it('sends text config before binary audio and drains trailing finals before finish', async () => {
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    const port = await listen(server)
    const received: { data: Buffer; isBinary: boolean }[] = []

    server.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => {
        const buffer = Buffer.from(data as ArrayBuffer)
        received.push({ data: buffer, isBinary })
        // Empty text frame is the live-compatible end-of-stream signal.
        if (!isBinary && buffer.length === 0) {
          socket.send(JSON.stringify({ tokens: [{ text: 'hello', is_final: true }] }))
          socket.send(JSON.stringify({ tokens: [], finished: true }), () => socket.close())
        }
      })
    })

    const sink = vi.fn()
    const session = new SonioxTranscriptionSession(
      'soniox-stt-rt-v5',
      () => 'integration-key',
      sink,
      () => new WebSocket(`ws://127.0.0.1:${port}`)
    )
    await session.start()
    session.feedAudio(new Float32Array([0.25, -0.25]), 16000)
    await session.finish()

    expect(received.map((frame) => frame.isBinary)).toEqual([false, true, false])
    expect(JSON.parse(received[0].data.toString('utf8'))).toMatchObject({
      api_key: 'integration-key',
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le'
    })
    expect(received[1].data).toHaveLength(4)
    expect(received[2].isBinary).toBe(false)
    expect(received[2].data).toHaveLength(0)
    expect(sink).toHaveBeenCalledWith({
      type: 'final',
      text: 'hello',
      preserveExactText: true
    })
  })

  it('surfaces an abrupt real WebSocket disconnect as a stable session error', async () => {
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    const port = await listen(server)
    const serverSocket = { terminate: undefined as (() => void) | undefined }
    server.once('connection', (socket) => {
      serverSocket.terminate = () => socket.terminate()
    })
    let resolveError: (message: string) => void = () => {}
    const errorReceived = new Promise<string>((resolve) => {
      resolveError = resolve
    })
    const session = new SonioxTranscriptionSession(
      'soniox-stt-rt-v5',
      () => 'integration-key',
      (event) => {
        if (event.type === 'error') {
          resolveError(event.error ?? '')
        }
      },
      () => new WebSocket(`ws://127.0.0.1:${port}`)
    )

    await session.start()
    serverSocket.terminate?.()

    await expect(errorReceived).resolves.toBe('Soniox connection closed unexpectedly')
  })
})
