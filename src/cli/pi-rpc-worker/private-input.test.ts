import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { BRACKETED_PASTE_BEGIN, BRACKETED_PASTE_END, MAX_PRIVATE_ENVELOPE_BYTES } from './envelope'
import { readPrivateDispatchFromStdin } from './private-input'

const envelope = {
  protocol: 'orca.pi.rpc-worker.dispatch',
  version: 1,
  taskId: 'task_1',
  dispatchId: 'ctx_1',
  workerHandle: 'term_1',
  capability: 'dcap_1',
  taskSpec: 'Implement the change.',
  cliCommand: 'orca'
}

function framed(): string {
  return `${BRACKETED_PASTE_BEGIN}${JSON.stringify(envelope)}${BRACKETED_PASTE_END}`
}

describe('private Pi dispatch input reader', () => {
  it('accepts one fragmented bracketed frame with an optional terminal submit', async () => {
    const input = new PassThrough()
    const result = readPrivateDispatchFromStdin(input)
    const frame = framed()
    input.write(frame.slice(0, 7))
    input.write(frame.slice(7))
    input.write('\r')
    await expect(result).resolves.toEqual(envelope)
  })

  it('fails closed when bytes trail the private frame', async () => {
    const input = new PassThrough()
    const result = readPrivateDispatchFromStdin(input)
    input.write(`${framed()}substituted`)
    await expect(result).rejects.toThrow('Unexpected bytes')
  })

  it('rejects input above the byte bound before parsing', async () => {
    const input = new PassThrough()
    const result = readPrivateDispatchFromStdin(input)
    input.write(Buffer.alloc(MAX_PRIVATE_ENVELOPE_BYTES + 1, 0x78))
    await expect(result).rejects.toThrow('byte limit')
  })
})
