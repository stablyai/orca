import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { openTrackedSshSocket } from './ssh-connection-channel-lifetime'
import { SshConnectionWorkLedger } from './ssh-connection-work-ledger'

it('acquires admission before a socket factory can connect', () => {
  const ledger = new SshConnectionWorkLedger()
  const open = vi.fn(() => new EventEmitter())
  ledger.fenceForReset()
  expect(() => openTrackedSshSocket(ledger, open)).toThrow('admission_closed')
  expect(open).not.toHaveBeenCalled()
})

it('waits for actual close rather than the destroyed flag', async () => {
  const ledger = new SshConnectionWorkLedger()
  const socket = openTrackedSshSocket(ledger, () =>
    Object.assign(new EventEmitter(), { destroyed: false })
  )
  const fence = ledger.fenceForReset()
  socket.destroyed = true
  expect(fence.assertDrained).toThrow('not_drained')
  socket.emit('close')
  await fence.drain(new AbortController().signal)
})

it('retains socket-construction uncertainty without accepting a later reset', async () => {
  const ledger = new SshConnectionWorkLedger()
  const failure = new Error('socket setup failed')
  expect(() =>
    openTrackedSshSocket(ledger, () => {
      throw failure
    })
  ).toThrow(failure)
  await expect(ledger.fenceForReset().drain(new AbortController().signal)).rejects.toBe(failure)
})
