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

const dispositions = ['held', 'consumed', 'discarded'] as const
const restarts = ['detach', 'replace', 'capacity loss', 'retired binding'] as const
const followups = ['read', 'discard', 'close chats', 'reload', 'exit'] as const

it.each([true, false])(
  'resets a discarded stream with either arrival order (discard first: %s)',
  async (discardFirst) => {
    const readers = new ProviderReceiptReaders(() => 'test')
    const source = new StructuredAgentSessionProviderReceipts(
      () => undefined,
      () => undefined
    )
    const transport = new AbortController()
    const endpoint = { transport: transport.signal, document: new AbortController().signal }
    const reader = { id: randomUUID(), generation: 1 }
    readers
      .attach(endpoint, reader, source, { sessionId: 'chat', subscription: 'sub' }, () => ({
        epoch: 'epoch',
        sequence: 0
      }))!
      .reachedHead()
    try {
      const first = await readers.read(
        endpoint,
        { reader, since: null, hostIncarnation: null },
        source
      )
      expect(readers.handoff(endpoint)).toBe(true)
      const discard = () => readers.discard(endpoint, first.revision)
      if (discardFirst) {
        discard()
        expect(readers.hasPostedReply(endpoint.transport)).toBe(false)
      }
      const next = await readers.read(
        endpoint,
        {
          reader,
          since: first.revision,
          hostIncarnation: source.incarnation,
          discarded: true
        },
        source
      )
      expect(next.streams[0]?.reset?.complete).toBe(true)
      expect(next.revision.sequence).toBe(first.revision.sequence + 1)
      expect(readers.handoff(endpoint)).toBe(true)
      discard()
      expect(readers.hasPostedReply(endpoint.transport)).toBe(true)
      readers.discard(endpoint, next.revision)
      expect(readers['credits']['unreadBytes']).toBe(0)
    } finally {
      transport.abort()
    }
  }
)

it.each(
  dispositions.flatMap((state) =>
    restarts.flatMap((restart) => followups.map((after) => [state, restart, after] as const))
  )
)('keeps exact credit through %s, %s, then %s', async (state, restart, after) => {
  const readers = new ProviderReceiptReaders(() => 'test')
  const source = new StructuredAgentSessionProviderReceipts(
    () => undefined,
    () => undefined
  )
  const transport = new AbortController()
  const document = new AbortController()
  const endpoint = { transport: transport.signal, document: document.signal }
  const reader = { id: randomUUID(), generation: 1 }
  const binding = { reader, pending: false }
  const cursor = () => ({ epoch: 'epoch', sequence: 0 })
  const attach = (generation: number) =>
    readers.attach(
      endpoint,
      { ...reader, generation },
      source,
      {
        sessionId: 'session',
        subscription: `sub-${generation}`
      },
      cursor
    )!
  const first = attach(1)
  first.reachedHead()
  const initial = await readers.read(
    endpoint,
    { reader, since: null, hostIncarnation: null },
    source
  )
  const input = { reader, since: initial.revision, hostIncarnation: source.incarnation }
  const bytes = readers.preparedReply(endpoint)!.encoded.byteLength
  const charge = (expected: number): void => {
    expect(readers['credits']['unreadBytes']).toBe(expected)
    expect(readers.hasPostedReply(transport.signal)).toBe(expected !== 0)
  }
  const discard = () => readers.discard(endpoint, initial.revision)
  const reservations: (() => void)[] = []
  try {
    expect(readers.handoff(endpoint)).toBe(true)
    charge(bytes)
    if (state === 'consumed') {
      const port = new AbortController()
      const parked = readers.read(endpoint, input, source, undefined, port.signal)
      charge(0)
      port.abort()
      await expect(parked).rejects.toThrow('provider_receipt_sender_retired')
    } else if (state === 'discarded') {
      discard()
      charge(0)
    }
    let held = state === 'held'
    let successor = restart === 'replace' ? attach(2) : undefined
    if (restart === 'detach' || restart === 'capacity loss') {
      first.close()
    }
    if (restart === 'capacity loss') {
      for (let i = 0; i < (held ? 255 : 256); i++) {
        const peer = {
          transport: new AbortController().signal,
          document: new AbortController().signal
        }
        reservations.push(
          readers.attach(peer, reader, source, { sessionId: 'peer', subscription: 'hold' }, cursor)!
            .close
        )
      }
    }
    expect(
      providerReceiptPortRequest(readers, endpoint, binding, restart !== 'retired binding', input)
        .kind
    ).toBe('restart')
    charge(held ? bytes : 0)
    if (after === 'read') {
      reservations.pop()?.()
      successor ??= attach(2)
      successor.reachedHead()
      const reply = await readers.read(
        endpoint,
        {
          ...input,
          reader: { ...reader, generation: 2 },
          discarded: state === 'discarded'
        },
        source
      )
      expect(reply.revision.sequence).toBe(initial.revision.sequence + 1)
      expect(reply.streams[0]?.reset?.complete).toBe(true)
      const nextBytes = readers.preparedReply(endpoint)!.encoded.byteLength
      expect(readers.handoff(endpoint)).toBe(true)
      discard()
      charge(nextBytes)
      readers.discard(endpoint, reply.revision)
      held = false
    } else if (after === 'discard' || after === 'close chats') {
      first.close()
      successor?.close()
      charge(held ? bytes : 0)
      if (after === 'discard') {
        readers.discard(endpoint, { ...initial.revision, nonce: randomUUID() })
        charge(held ? bytes : 0)
        discard()
        held = false
      }
    } else if (after === 'reload') {
      document.abort()
      readers.retireDocument(endpoint)
      const nextDocument = { ...endpoint, document: new AbortController().signal }
      readers.discard(nextDocument, initial.revision)
      reservations.pop()?.()
      expect(readers.canBind(nextDocument)).toBe(!held)
    } else {
      transport.abort()
      held = false
    }
    charge(held ? bytes : 0)
    if (!held) {
      discard()
      charge(0)
    }
  } finally {
    transport.abort()
    for (const release of reservations) {
      release()
    }
  }
})
