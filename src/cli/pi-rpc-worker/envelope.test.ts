import { describe, expect, it } from 'vitest'
import {
  BRACKETED_PASTE_BEGIN,
  BRACKETED_PASTE_END,
  MAX_PRIVATE_ENVELOPE_BYTES,
  decodePrivateDispatchEnvelope,
  parsePrivateDispatchEnvelope,
  stripBracketedPasteEnvelope
} from './envelope'

const envelope = {
  protocol: 'orca.pi.rpc-worker.dispatch',
  version: 1,
  taskId: 'task_1',
  dispatchId: 'ctx_1',
  workerHandle: 'term_1',
  capability: 'secret-capability',
  taskSpec: 'Implement the focused change.',
  cliCommand: 'orca-ide'
}

function frame(value: unknown, suffix = ''): Buffer {
  return Buffer.from(
    `${BRACKETED_PASTE_BEGIN}${JSON.stringify(value)}${BRACKETED_PASTE_END}${suffix}`
  )
}

describe('private Pi worker dispatch envelope', () => {
  it('strips one bracketed paste frame and one terminal submit suffix', () => {
    expect(stripBracketedPasteEnvelope(frame(envelope, '\r'))).toBe(JSON.stringify(envelope))
    expect(decodePrivateDispatchEnvelope(frame(envelope))).toEqual(envelope)
  })

  it('rejects unframed, duplicated, and trailing private input', () => {
    expect(() => stripBracketedPasteEnvelope(Buffer.from(JSON.stringify(envelope)))).toThrow(
      'not bracketed paste'
    )
    expect(() =>
      stripBracketedPasteEnvelope(Buffer.concat([frame(envelope), frame(envelope)]))
    ).toThrow('Unexpected bytes')
    expect(() => stripBracketedPasteEnvelope(frame(envelope, 'x'))).toThrow('Unexpected bytes')
  })

  it('requires exactly the bounded protocol fields', () => {
    expect(() =>
      parsePrivateDispatchEnvelope(JSON.stringify({ ...envelope, extra: true }))
    ).toThrow('envelope_invalid')
    expect(() => parsePrivateDispatchEnvelope(JSON.stringify({ ...envelope, version: 2 }))).toThrow(
      'protocol_unsupported'
    )
    expect(() =>
      parsePrivateDispatchEnvelope(JSON.stringify({ ...envelope, cliCommand: 'arbitrary' }))
    ).toThrow('cli_command_invalid')
    expect(() =>
      parsePrivateDispatchEnvelope(JSON.stringify({ ...envelope, taskId: 'x'.repeat(257) }))
    ).toThrow('taskId_invalid')
  })

  it('rejects invalid UTF-8 and oversized frames before JSON parsing', () => {
    const invalid = Buffer.concat([
      Buffer.from(BRACKETED_PASTE_BEGIN),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(BRACKETED_PASTE_END)
    ])
    expect(() => stripBracketedPasteEnvelope(invalid)).toThrow('valid UTF-8')
    expect(() => stripBracketedPasteEnvelope(Buffer.alloc(MAX_PRIVATE_ENVELOPE_BYTES + 1))).toThrow(
      'byte limit'
    )
  })
})
