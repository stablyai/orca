import { EventEmitter } from 'node:events'
import type { Client, ClientChannel } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { SshConnectionWorkLedger } from './ssh-connection-work-ledger'
import { forwardTrackedSshChannel } from './ssh-forward-channel-lifetime'

function fixture() {
  const ledger = new SshConnectionWorkLedger()
  const local = new EventEmitter()
  const remote = new EventEmitter() as ClientChannel
  let opened!: NonNullable<Parameters<Client['forwardOut']>[4]>
  const client = {
    forwardOut: vi.fn((_a, _b, _c, _d, callback) => {
      opened = callback
    })
  }
  const callback = vi.fn()
  const start = () =>
    forwardTrackedSshChannel(
      ledger,
      client as unknown as Client,
      local,
      '127.0.0.1',
      0,
      'remote.internal',
      443,
      callback
    )
  return { ledger, local, remote, client, callback, start, opened: () => opened }
}

it('tracks a pending open and both physical ends without terminating either', async () => {
  const f = fixture()
  f.start()
  const fence = f.ledger.fenceForReset()
  expect(fence.assertDrained).toThrow('not_drained')
  f.opened()(undefined, f.remote)
  expect(f.callback).toHaveBeenCalledWith(undefined, f.remote)
  f.remote.emit('close')
  expect(fence.assertDrained).toThrow('not_drained')
  f.local.emit('close')
  await fence.drain(new AbortController().signal)
})

it('retains late channels after the local socket closes', async () => {
  const f = fixture()
  f.start()
  f.local.emit('close')
  const fence = f.ledger.fenceForReset()
  f.opened()(undefined, f.remote)
  expect(fence.assertDrained).toThrow('not_drained')
  f.remote.emit('close')
  await fence.drain(new AbortController().signal)
})

it('refuses fenced opens before forwarding or subscribing to the new socket', () => {
  const f = fixture()
  f.ledger.fenceForReset()
  expect(f.start).toThrow('admission_closed')
  expect(f.client.forwardOut).not.toHaveBeenCalled()
  expect(f.local.listenerCount('close')).toBe(0)
})

it('retains open failures during reset rather than claiming successful drain', async () => {
  const f = fixture()
  f.start()
  const fence = f.ledger.fenceForReset()
  const failure = new Error('forward failed')
  f.opened()(failure, undefined as never)
  f.local.emit('close')
  await expect(fence.drain(new AbortController().signal)).rejects.toBe(failure)
})

it('retains synchronous open uncertainty even when reset begins later', async () => {
  const f = fixture()
  const failure = new Error('transport failed')
  f.client.forwardOut.mockImplementation(() => {
    throw failure
  })
  expect(f.start).toThrow(failure)
  f.local.emit('close')
  await expect(f.ledger.fenceForReset().drain(new AbortController().signal)).rejects.toBe(failure)
})

it('aborting observation preserves the admitted sockets and allows another drain', async () => {
  const f = fixture()
  f.start()
  const fence = f.ledger.fenceForReset()
  const observer = new AbortController()
  const draining = fence.drain(observer.signal).catch((error: unknown) => error)
  const failure = new Error('observer stopped')
  observer.abort(failure)
  expect(await draining).toBe(failure)
  f.opened()(undefined, f.remote)
  f.local.emit('close')
  f.remote.emit('close')
  await fence.drain(new AbortController().signal)
})
