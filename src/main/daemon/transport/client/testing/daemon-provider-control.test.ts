import { Socket } from 'node:net'
import { expect, it, vi } from 'vitest'
import { DaemonProviderObservers } from '../daemon-provider-observers'
import {
  attachControlResponseReader,
  attachStreamEventReader
} from '../daemon-client-ndjson-readers'

it.each([10, 100])('addresses one of %i provider owners without PTY fanout', async (count) => {
  const providers = new DaemonProviderObservers()
  const owners = Array.from({ length: count }, () => vi.fn())
  const remove = owners.map((owner, i) => providers.add(String(i), owner))
  const control = new Socket()
  const stream = new Socket()
  const response = vi.fn()
  const terminal = vi.fn()
  const off = attachControlResponseReader(control, response, Buffer.alloc(0), (event) =>
    providers.observe(event)
  )
  const reader = attachStreamEventReader(
    stream,
    { streamFraming: 'ndjson', remainder: Buffer.alloc(0) },
    terminal
  )
  try {
    stream.push(
      Buffer.from('{"type":"event","event":"data","sessionId":"pty","payload":{"data":"hello"}}\n')
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(terminal).toHaveBeenCalledTimes(1)
    expect(owners.reduce((sum, owner) => sum + owner.mock.calls.length, 0)).toBe(0)
    control.push(
      Buffer.from(
        '{"type":"providerExit","nonce":"0","outcome":{"pid":42,"code":7,"signal":null,"processless":false}}\n'
      )
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(owners[0]).toHaveBeenCalledExactlyOnceWith({
      pid: 42,
      code: 7,
      signal: null,
      processless: false
    })
    expect(owners.reduce((sum, owner) => sum + owner.mock.calls.length, 0)).toBe(1)
    expect(response).not.toHaveBeenCalled()
    for (const cleanup of remove) {
      cleanup()
    }
    providers.observe({
      type: 'providerExit',
      nonce: '0',
      outcome: { pid: 42, code: 7, signal: null, processless: false }
    })
    expect(owners[0]).toHaveBeenCalledTimes(1)
  } finally {
    off()
    reader.detach()
    control.destroy()
    stream.destroy()
  }
})
