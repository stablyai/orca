import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AvccFrameStream } from './avcc-frame-stream'

function packet(tag: number, payload: number[]): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length + 1, 0)
  header[4] = tag
  return Buffer.concat([header, Buffer.from(payload)])
}

const servers: Server[] = []

async function serve(handler: (response: ServerResponse) => void): Promise<string> {
  const server = createServer((_request, response) => handler(response))
  servers.push(server)
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Test server has no TCP address')
  }
  return `http://127.0.0.1:${address.port}/stream.avcc`
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
  }
})

describe('AvccFrameStream', () => {
  it('stays open while packets keep arriving and fails once the helper goes silent', async () => {
    // Real time: the stall is Node's socket idle timeout, which fake timers cannot drive.
    // Packets every 40 ms span longer than the 500 ms stall, so only an idle timeout passes.
    let sent = 0
    const url = await serve((response) => {
      response.writeHead(200)
      response.write(packet(1, [1, 0x64, 0, 0x33]))
      const timer = setInterval(() => {
        response.write(packet(3, [sent]))
        sent += 1
        if (sent === 15) {
          clearInterval(timer)
        }
      }, 40)
    })
    const onFrame = vi.fn()
    const onError = vi.fn()
    const stream = new AvccFrameStream(url, { onFrame, onError }, 500)
    stream.start()

    await vi.waitFor(
      () => expect(onError).toHaveBeenCalledWith('Simulator video stream stalled.'),
      { timeout: 3_000 }
    )
    expect(onFrame).toHaveBeenCalledTimes(16)
    stream.stop()
  })

  it('does not mistake an overdue idle timer after sleep for a stall', async () => {
    let resume = (): void => {}
    const url = await serve((response) => {
      response.writeHead(200)
      response.write(packet(1, [1, 0x64, 0, 0x33]))
      resume = () => response.write(packet(2, [9]))
    })
    const onFrame = vi.fn()
    const onError = vi.fn()
    const stream = new AvccFrameStream(url, { onFrame, onError }, 200)
    stream.start()
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledOnce())

    // Stand-in for system sleep: the helper sleeps too, so its next frame arrives 80 ms after wake,
    // once the overdue idle timer has been handled and within the re-armed window.
    await freezeLoop(600, () => setTimeout(resume, 680))

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(2))
    expect(onError).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Simulator video stream stalled.'))
    stream.stop()
  })

  it('reads frames queued while the event loop was blocked before declaring a stall', async () => {
    let send = (): void => {}
    const url = await serve((response) => {
      response.writeHead(200)
      response.write(packet(1, [1, 0x64, 0, 0x33]))
      send = () => response.write(packet(2, [9]))
    })
    const onFrame = vi.fn()
    const onError = vi.fn()
    const stream = new AvccFrameStream(url, { onFrame, onError }, 1_000)
    stream.start()
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledOnce())

    // The frame is queued before the freeze, which overruns the stall window by less than a sleep would.
    await freezeLoop(1_150, send)

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(2))
    expect(onError).not.toHaveBeenCalled()
    stream.stop()
  })
})

// Freezes from the check phase so the next loop turn runs the overdue idle timer before socket reads.
async function freezeLoop(ms: number, beforeFreeze = (): void => {}): Promise<void> {
  const frozen = Promise.withResolvers<void>()
  setImmediate(() => {
    beforeFreeze()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    frozen.resolve()
  })
  await frozen.promise
}
