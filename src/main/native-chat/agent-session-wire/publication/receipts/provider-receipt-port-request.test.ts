import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { StructuredAgentSessionProviderReceipts } from '../../host/structured-agent-session-provider-receipts'
import { ProviderReceiptReaders } from './provider-receipt-readers'
import { providerReceiptPortRequest } from './provider-receipt-port-request'

const transitions = [
  ['current', 'read', 'drop'],
  ['pending', 'drop', 'drop'],
  ['superseded', 'restart', 'drop'],
  ['detached', 'restart', 'drop'],
  ['capacity taken', 'restart', 'drop'],
  ['retired', 'restart', 'drop'],
  ['posted', 'drop', 'read'],
  ['superseded and posted', 'drop', 'restart'],
  ['retired and posted', 'drop', 'restart']
] as const

it.each(transitions)('routes reads on a %s binding', async (state, first, continuation) => {
  const source = new StructuredAgentSessionProviderReceipts(
    () => undefined,
    () => undefined
  )
  const readers = new ProviderReceiptReaders(() => 'test')
  const controllers: AbortController[] = []
  const start = () => {
    const controller = new AbortController()
    const document = new AbortController()
    controllers.push(controller)
    const endpoint = { transport: controller.signal, document: document.signal }
    const reader = { id: randomUUID(), generation: 1 }
    const attach = (generation: number, subscription = 'initial') =>
      readers.attach(
        endpoint,
        { ...reader, generation },
        source,
        { sessionId: 'session', subscription },
        () => ({ epoch: 'epoch', sequence: 0 })
      )!
    return { endpoint, reader, attach }
  }

  try {
    const { endpoint, reader, attach } = start()
    const interest = attach(1)
    interest.reachedHead()
    const input = { reader, since: null, hostIncarnation: null }
    const carriesReply = state.includes('posted')
    const previous = carriesReply ? await readers.read(endpoint, input, source) : undefined
    if (previous) {
      expect(readers.handoff(endpoint)).toBe(true)
    }
    if (state.startsWith('superseded')) {
      attach(2).reachedHead()
    }
    if (state === 'detached' || state === 'capacity taken') {
      interest.close()
    }
    if (state === 'capacity taken') {
      for (let i = 0; i < 256; i++) {
        expect(start().attach(1)).toBeDefined()
      }
    }
    const request = (value: unknown) =>
      providerReceiptPortRequest(
        readers,
        endpoint,
        { reader, pending: state === 'pending' },
        !state.startsWith('retired'),
        value
      )
    const exact = { ...input, since: previous?.revision ?? { sequence: 1, nonce: randomUUID() } }
    expect(request(input).kind).toBe(first)
    expect(request(exact).kind).toBe(continuation)
    expect(request({ ...exact, since: { ...exact.since, nonce: randomUUID() } }).kind).toBe('drop')
    expect(request({ ...input, reader: { ...reader, generation: 2 } }).kind).toBe('drop')
    expect(request({ ...input, reader: { ...reader, id: randomUUID() } }).kind).toBe('drop')
    expect(request({ ...input, extra: true }).kind).toBe('drop')
    expect(request(undefined).kind).toBe('drop')
    expect(readers.hasPostedReply(endpoint.transport)).toBe(carriesReply)
    if (first === 'read' || continuation === 'read') {
      if (carriesReply) {
        attach(1, 'next').reachedHead()
      }
      const admitted = carriesReply ? exact : input
      const reply = await readers.read(endpoint, admitted, source)
      const prepared = readers.preparedReply(endpoint)
      let posted: Uint8Array | undefined
      const send = (bytes: Uint8Array): void => {
        posted = bytes
      }
      expect(readers.handoff(endpoint, send)).toBe(true)
      expect(readers.handoff(endpoint, send)).toBe(false)
      expect(posted).toBe(prepared?.encoded)
      expect(JSON.parse(new TextDecoder().decode(posted)).result).toEqual(reply)
      expect(readers.hasPostedReply(endpoint.transport)).toBe(true)
    }
  } finally {
    for (const controller of controllers) {
      controller.abort()
    }
  }
})
