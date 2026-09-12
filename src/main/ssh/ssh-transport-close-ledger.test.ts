import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { SshTransportCloseLedger } from './ssh-transport-close-ledger'

function fixture() {
  const ledger = new SshTransportCloseLedger()
  const allocate = () => {
    const client = new EventEmitter()
    ledger.track(client as Client)
    return client
  }
  return { ledger, allocate }
}

it('waits for all allocated clients, including failed authentication attempts', async () => {
  const { ledger, allocate } = fixture()
  const failed = allocate()
  const successful = allocate()
  const done = vi.fn()
  const draining = ledger.drain(new AbortController().signal).then(done)
  failed.emit('end')
  successful.emit('close')
  await Promise.resolve()
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  failed.emit('close')
  await draining
  expect(done).toHaveBeenCalledOnce()
  expect(failed.listenerCount('close')).toBe(0)
  expect(successful.listenerCount('close')).toBe(0)
})

it('remembers closure before drain and does not accumulate listeners', async () => {
  const { ledger, allocate } = fixture()
  for (let i = 0; i < 100; i++) {
    const client = allocate()
    ledger.track(client as Client)
    expect(client.listenerCount('close')).toBe(1)
    client.emit('close')
    expect(client.listenerCount('close')).toBe(0)
  }
  await ledger.drain(new AbortController().signal)
  await ledger.drain(new AbortController().signal)
})

it('retains physical closure evidence across canceled waits', async () => {
  const { ledger, allocate } = fixture()
  const client = allocate()
  const controller = new AbortController()
  const draining = ledger.drain(controller.signal)
  controller.abort()
  await expect(draining).rejects.toThrow()
  expect(client.listenerCount('close')).toBe(1)
  const retry = ledger.drain(new AbortController().signal)
  client.emit('close')
  await retry
  expect(client.listenerCount('close')).toBe(0)
})

it('refuses new outstanding allocations made after the drain snapshot', async () => {
  const { ledger, allocate } = fixture()
  const original = allocate()
  const draining = ledger.drain(new AbortController().signal)
  const late = allocate()
  original.emit('close')
  await expect(draining).rejects.toThrow('ssh_client_close_allocations_changed')
  late.emit('close')
  await ledger.drain(new AbortController().signal)
})
