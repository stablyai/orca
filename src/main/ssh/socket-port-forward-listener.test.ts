import { connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { startSocketPortForwardListener } from './socket-port-forward-listener'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
})

async function fixture(open = vi.fn(async (_socket: Socket) => new PassThrough())) {
  const listener = await startSocketPortForwardListener({
    forward: {
      id: 'forward',
      connectionId: 'target',
      localHost: '127.0.0.1',
      localPort: 0,
      remoteHost: 'remote',
      remotePort: 80
    },
    open,
    disposeDestination: (destination) => destination.destroy()
  })
  cleanup.push(listener.close)
  const client = connect(listener.entry.localPort, '127.0.0.1')
  client.on('error', () => {})
  cleanup.push(() => {
    client.destroy()
  })
  await once(client, 'connect')
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
  return { listener, client, open }
}

it('fences accepts without truncating an admitted half-closed stream', async () => {
  const f = await fixture()
  const chunks: Buffer[] = []
  f.client.on('data', (data: Buffer) => chunks.push(data))
  const closed = once(f.client, 'close')
  const fence = f.listener.fenceForDrain()
  expect(() => fence.assertDrained()).toThrow()
  const payload = Buffer.alloc(96 * 1024, 0x64)
  f.client.end(payload)
  await Promise.all([closed, fence.drain(new AbortController().signal)])
  expect(Buffer.concat(chunks).equals(payload)).toBe(true)
  fence.assertDrained()
})

it('retains a pending destination open across fence and aborted observation', async () => {
  const ready = Promise.withResolvers<PassThrough>()
  const f = await fixture(vi.fn(() => ready.promise))
  const fence = f.listener.fenceForDrain()
  const abort = new AbortController()
  const waiting = fence.drain(abort.signal)
  abort.abort(new Error('observer cancelled'))
  await expect(waiting).rejects.toThrow('observer cancelled')
  expect(f.client.destroyed).toBe(false)
  ready.resolve(new PassThrough())
  f.client.resume()
  const closed = once(f.client, 'close')
  f.client.end('admitted')
  await Promise.all([closed, fence.drain(new AbortController().signal)])
  fence.assertDrained()
})

it('never treats explicit removal of a live socket as a successful drain', async () => {
  const f = await fixture()
  const fence = f.listener.fenceForDrain()
  await f.listener.close()
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('close_unverifiable')
  expect(() => fence.assertDrained()).toThrow('close_unverifiable')
})
