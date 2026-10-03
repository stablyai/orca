import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { observeSshTransportClose } from './ssh-transport-close-observation'

it('resolves only after every observed resource emits close', async () => {
  const client = new EventEmitter()
  client.on('error', () => {})
  const proxy = new EventEmitter()
  const observation = observeSshTransportClose([client, proxy])
  const done = vi.fn()
  const waiting = observation.wait(new AbortController().signal).then(done)
  client.emit('end')
  client.emit('error', new Error('reset by peer'))
  client.emit('close')
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  proxy.emit('close')
  await waiting
  expect(done).toHaveBeenCalledOnce()
})

it('cancels only the wait and removes its listeners on dispose', async () => {
  const client = new EventEmitter()
  client.on('error', () => {})
  const observation = observeSshTransportClose([client])
  const controller = new AbortController()
  const waiting = observation.wait(controller.signal)
  controller.abort(new Error('caller gave up'))
  await expect(waiting).rejects.toThrow('caller gave up')
  expect(client.listenerCount('close')).toBe(1)
  observation.dispose()
  expect(client.listenerCount('close')).toBe(0)
})
