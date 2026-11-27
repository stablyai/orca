import { randomUUID } from 'node:crypto'
import { serialize } from 'node:v8'
import { expect, it } from 'vitest'
import {
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  type ProviderReceiptReply,
  type ProviderReceiptRead
} from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import { ProviderReceiptReaders } from '../../publication/receipts/provider-receipt-readers'
import { StructuredAgentSessionProviderReceipts } from '../structured-agent-session-provider-receipts'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  claudeReceiptIngress,
  receiptDestination
} from './structured-agent-session-provider-receipt-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION as CHAT,
  HOST_TEST_NOW as NOW
} from './structured-agent-session-host-test-data.test-fixture'

async function receiptRig(agent?: 'claude') {
  const rig = await createQueuedMessageTestRig({ agent })
  const seed = await rig.workingSend()
  const session = await rig.host.conversation(CHAT)
  const { journal, child } = session
  const source = new StructuredAgentSessionProviderReceipts(
    () => session,
    () => child!.fence
  )
  const readers = new ProviderReceiptReaders(() => 'fixture-runtime')
  const cursor = () => journal.cursor()
  const stamp = (sessionId: string, clientMessageId: string, sequence: number) => {
    const observation = {
      clientMessageId,
      attempt: 1,
      handoverCursor: { epoch: journal.physicalCursor().epoch, sequence },
      fence: child!.fence,
      observedAt: NOW + sequence
    }
    source.register(sessionId, journal, child!, clientMessageId, observation)
    source.stamp(sessionId, child!, observation)
    return () => source.withdraw(sessionId, child!, observation)
  }
  const destinations = new Set<AbortController>()
  const renderer = () => {
    const endpoint = receiptDestination()
    destinations.add(endpoint.transport)
    const reader = { id: randomUUID(), generation: 1 }
    const attach = (subscription: string, sessionId = CHAT) =>
      readers.attach(endpoint.endpoint, { ...reader }, source, { sessionId, subscription }, cursor)
    const read = (previous?: ProviderReceiptReply, override?: Partial<ProviderReceiptRead>) =>
      readers.read(
        endpoint.endpoint,
        {
          reader,
          since: previous?.revision ?? null,
          hostIncarnation: previous?.hostIncarnation ?? null,
          ...override
        },
        source
      )
    return { ...endpoint, reader, attach, read }
  }
  const dispose = async () => {
    for (const controller of destinations) {
      controller.abort()
    }
    source.close()
    await rig.dispose()
  }
  return { rig, seed, session, source, readers, cursor, stamp, renderer, dispose }
}

it('keeps one credit through invalid continuations, replacement, terminal detach and discard', async () => {
  const rig = await receiptRig()
  try {
    const renderer = rig.renderer()
    const first = renderer.attach('old')!
    first.reachedHead()
    const initial = await renderer.read()
    rig.readers.handoff(renderer.endpoint)
    expect(initial.streams[0]).toMatchObject({ reset: { complete: true }, updates: [] })
    expect(() => renderer.read()).toThrow('provider_receipt_read_pending')
    expect(() => renderer.read(initial, { since: { ...initial.revision, sequence: 2 } })).toThrow()
    expect(() =>
      renderer.read(initial, { since: { ...initial.revision, nonce: randomUUID() } })
    ).toThrow()
    const peer = rig.renderer()
    rig.readers.discard(peer.endpoint, initial.revision)
    expect(() => renderer.read()).toThrow()

    renderer.reader.generation++
    const successor = renderer.attach('new')!
    expect(
      rig.readers.attach(
        renderer.endpoint,
        { ...renderer.reader, generation: 1 },
        rig.source,
        { sessionId: CHAT, subscription: 'old' },
        rig.cursor
      )
    ).toBeUndefined()
    first.close()
    const pending = renderer.read(initial, { discarded: true })
    let sent = false
    void pending.then(() => {
      sent = true
    })
    await Promise.resolve()
    expect(sent).toBe(false)
    successor.reachedHead()
    const reset = await pending
    expect(reset.streams[0]).toMatchObject({
      subscription: 'new',
      generation: 2,
      reset: { complete: true }
    })
    rig.readers.handoff(renderer.endpoint)
    const detached = renderer.read(reset)
    successor.close()
    const terminal = await detached
    expect(terminal.status).toBe('detached')
    rig.readers.handoff(renderer.endpoint)
    expect(() => renderer.read(reset)).toThrow()
    rig.readers.discard(renderer.endpoint, terminal.revision)
    renderer.attach('reopened')!.reachedHead()
    expect(() =>
      renderer.read(terminal, { since: { ...terminal.revision, nonce: randomUUID() } })
    ).toThrow('provider_receipt_read_pending')
    const reopened = await renderer.read(terminal)
    expect(reopened.revision.sequence).toBe(terminal.revision.sequence + 1)
    expect(reopened.streams[0]).toMatchObject({ subscription: 'reopened' })
  } finally {
    await rig.dispose()
  }
})

it('distinguishes duplicate waits, host restart, shutdown and transport loss', async () => {
  const rig = await receiptRig()
  try {
    const renderer = rig.renderer()
    renderer.attach('subscription')!.reachedHead()
    let reply = await renderer.read(undefined, { hostIncarnation: randomUUID() })
    expect(reply.status).toBe('host_restarted')
    rig.readers.handoff(renderer.endpoint)
    reply = await renderer.read(reply)
    expect(reply.status).toBe('changed')
    rig.readers.handoff(renderer.endpoint)
    const parked = renderer.read(reply)
    expect(() => renderer.read(reply)).toThrow()
    expect(() => renderer.read(reply, { since: null })).toThrow()
    rig.source.close()
    const terminal = await parked
    expect(terminal.status).toBe('closed')
    rig.readers.handoff(renderer.endpoint)
    renderer.transport.abort()
    expect(() => renderer.read()).toThrow('provider_receipt_sender_retired')
  } finally {
    await rig.dispose()
  }
})

it('suppresses a pre-handoff reply on reload and retains an already handed-off reply', async () => {
  const rig = await receiptRig()
  try {
    for (const delivered of [false, true]) {
      const renderer = rig.renderer()
      const interest = renderer.attach('first')!
      interest.reachedHead()
      const reply = await renderer.read()
      expect(rig.readers.hasPostedReply(renderer.transport.signal)).toBe(false)
      if (delivered) {
        rig.readers.handoff(renderer.endpoint)
        expect(rig.readers.hasPostedReply(renderer.transport.signal)).toBe(true)
      }
      renderer.document.abort()
      interest.close()
      const successor = {
        transport: renderer.transport.signal,
        document: new AbortController().signal
      }
      rig.readers.suppress(renderer.endpoint)
      const next = () =>
        rig.readers.read(
          successor,
          {
            reader: renderer.reader,
            hostIncarnation: null,
            since: null
          },
          rig.source
        )
      if (delivered) {
        expect(() => next()).toThrow()
        rig.readers.discard(successor, reply.revision)
        expect(() => next()).toThrow()
      } else {
        expect((await next()).status).toBe('reader_unknown')
      }
      renderer.transport.abort()
      if (delivered) {
        const reopened = rig.renderer()
        reopened.attach('successor')!.reachedHead()
        expect((await reopened.read()).status).toBe('changed')
      }
    }

    const renderer = rig.renderer()
    renderer.attach('parked')!
    const waiting = renderer.read()
    renderer.document.abort()
    await expect(waiting).rejects.toThrow('provider_receipt_sender_retired')
  } finally {
    await rig.dispose()
  }
})

it('keeps a quiet read parked, skips a net no-op and wakes on a real change', async () => {
  const rig = await receiptRig()
  try {
    const renderer = rig.renderer()
    renderer.attach('first')!.reachedHead()
    const initial = await renderer.read()
    rig.readers.handoff(renderer.endpoint)
    const next = renderer.read(initial)
    let sent = false
    void next.then(() => {
      sent = true
    })
    rig.stamp(CHAT, 'transient', 1)()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sent).toBe(false)
    rig.stamp(CHAT, 'real', 2)
    expect((await next).streams[0]).toMatchObject({
      reset: null,
      updates: [
        {
          clientMessageId: 'real',
          fence: expect.any(Number),
          attempt: 1,
          handoverSequence: 2,
          observedAt: NOW + 2
        }
      ]
    })
  } finally {
    await rig.dispose()
  }
})

it('pages maximum-width resets and gives other chats a turn during interleaved settlement', async () => {
  const rig = await receiptRig()
  try {
    const key = (n: number) => String(n).padStart(512, '\u0000')
    const stamps = Array.from({ length: 256 }, (_, index) => rig.stamp(CHAT, key(index), index))
    const renderer = rig.renderer()
    renderer.attach('large')!.reachedHead()
    renderer.attach('quiet', 'other-chat')!.reachedHead()
    let reply = await renderer.read()
    rig.readers.handoff(renderer.endpoint)
    const first = reply.streams[0]!
    expect(first).toMatchObject({ subscription: 'large', reset: { offset: 0, complete: false } })
    expect(first.updates.length).toBeGreaterThan(0)
    const id = first.reset!.id
    const observed: string[] = first.updates.map((update) => update.clientMessageId)
    stamps[0]!()
    const interleaved = await renderer.read(reply)
    rig.readers.handoff(renderer.endpoint)
    expect(interleaved.streams[0]).toMatchObject({
      subscription: 'quiet',
      reset: { complete: true },
      updates: []
    })
    reply = interleaved
    for (let page = 1; page < 8; page++) {
      if (observed.length === 256) {
        break
      }
      reply = await renderer.read(reply)
      rig.readers.handoff(renderer.endpoint)
      const chunk = reply.streams[0]!
      expect(chunk).toMatchObject({ subscription: 'large', reset: { id, offset: observed.length } })
      observed.push(...chunk.updates.map((update) => update.clientMessageId))
      const envelope = {
        id: 'desktop-ipc',
        ok: true,
        result: reply,
        _meta: { runtimeId: 'fixture-runtime' }
      }
      expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(
        MAX_PROVIDER_RECEIPT_REPLY_BYTES
      )
      expect(chunk.reset!.complete).toBe(observed.length === 256)
    }
    expect(observed).toEqual(Array.from({ length: 256 }, (_, index) => key(index)))
    const delta = await renderer.read(reply)
    expect(delta.streams[0]).toMatchObject({
      reset: null,
      updates: [{ clientMessageId: key(0), observedAt: null }]
    })
  } finally {
    await rig.dispose()
  }
})

it('caps 256 destinations and 4,096 handovers and wakes a blocked reader on credit alone', async () => {
  const rig = await receiptRig()
  try {
    for (let i = 0; i < 4096; i++) {
      rig.stamp(
        i < 256 ? CHAT : `chat-${Math.floor(i / 256)}`,
        String(i).padStart(512, '\u0000'),
        i
      )
    }
    rig.stamp('overflow', 'unindexed', 4097)
    expect(rig.source.stampFor('overflow', 'unindexed')).toBeUndefined()
    rig.source.retire('chat-1')
    rig.stamp('overflow', 'now-fits', 4098)
    expect(rig.source.stampFor('overflow', 'now-fits')?.observedAt).toBe(NOW + 4098)
    const fleet = Array.from({ length: 256 }, (_, index) => {
      const renderer = rig.renderer()
      renderer.attach(`subscription-${index}`)!.reachedHead()
      return renderer
    })
    const excess = rig.renderer()
    expect(excess.attach('257th')).toBeUndefined()
    expect(() => excess.read()).toThrow('provider_receipt_capacity')

    const handedOff = new Map<number, ProviderReceiptReply>()
    const pending = fleet.map((renderer, index) =>
      renderer.read().then(
        (reply) => {
          rig.readers.handoff(renderer.endpoint)
          handedOff.set(index, reply)
          return reply
        },
        () => undefined
      )
    )
    await Promise.resolve()
    const saturated = handedOff.size
    const envelopes = [...handedOff.values()].map((result) => ({
      id: 'desktop-ipc',
      ok: true,
      result,
      _meta: { runtimeId: 'fixture-runtime' }
    }))
    const bytes = envelopes.reduce(
      (total, envelope) => total + Buffer.byteLength(JSON.stringify(envelope)),
      0
    )
    const serialized = envelopes.reduce(
      (total, envelope) => total + serialize(envelope).byteLength,
      0
    )
    console.log({ saturated, encodedBytes: bytes, nodeV8SerializedBytes: serialized })
    expect(saturated).toBeGreaterThan(35)
    expect(saturated).toBeLessThan(40)
    expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(handedOff.get(saturated)).toBeUndefined()
    const first = handedOff.get(0)!
    rig.readers.discard(fleet[0]!.endpoint, first.revision)
    expect((await pending[saturated])?.status).toBe('changed')
    fleet[0]!.transport.abort()
    expect(excess.attach('new-slot')).toBeDefined()
  } finally {
    await rig.dispose()
  }
})

it.each(['destination', 'handover'] as const)(
  'keeps durable Claude echo settlement when the receipt %s is refused',
  async (limit) => {
    const { rig, seed, session, source, readers, stamp, renderer, dispose } =
      await receiptRig('claude')
    try {
      await rig.settleAccepted(seed, 'seed')
      // Alias the same journal owner for fixture entries while exercising the production index.
      session.providerReceipts = source
      if (limit === 'handover') {
        for (let i = 0; i < 4096; i++) {
          stamp(`chat-${Math.floor(i / 64)}`, `handover-${i}`, i)
        }
      } else {
        for (let i = 0; i < 256; i++) {
          expect(renderer().attach(`reader-${i}`)).toBeDefined()
        }
        const excess = renderer()
        expect(excess.attach('overflow')).toBeUndefined()
        expect(readers.canOpenPort(excess.endpoint, excess.reader)).toBe(false)
      }
      const id = await rig.workingSend()
      await eventually(() => expect(rig.dispatch.mock.lastCall?.[0].clientMessageId).toBe(id))
      expect(await rig.submission(id)).toMatchObject({ dispatchState: 'pending' })
      const ingress = claudeReceiptIngress(rig)
      ingress.lifecycle('queued', NOW + 100)
      expect(source.stampFor(CHAT, id)?.observedAt).toBe(
        limit === 'handover' ? undefined : NOW + 100
      )
      ingress.echo()
      expect(await ingress.flush()).toEqual({ ok: true })
      expect(await rig.submission(id)).toMatchObject({ dispatchState: 'accepted' })
    } finally {
      await dispose()
    }
  }
)

it.each([16, 160])('multiplexes %s streams with one waiting read', async (count) => {
  const rig = await receiptRig()
  try {
    const renderer = rig.renderer()
    const streams = Array.from({ length: count }, (_, index) =>
      renderer.attach(String(index), String(index))!
    )
    const waiting = renderer.read()
    const changed = String(count - 1)
    streams[count - 1]!.reachedHead()
    const first = await waiting
    expect(first.streams.map((stream) => stream.subscription)).toEqual([changed])
    rig.readers.handoff(renderer.endpoint)
    expect(() => renderer.read()).toThrow()
    const next = renderer.read(first)
    rig.stamp(changed, 'stamp', 1)
    expect((await next).streams[0]).toMatchObject({
      subscription: changed,
      reset: null,
      updates: [{ clientMessageId: 'stamp' }]
    })
  } finally {
    await rig.dispose()
  }
})

it.each([1_000, 10_000])('retains one physical credit through %s replacements', async (count) => {
  const rig = await receiptRig()
  try {
    const renderer = rig.renderer()
    let previous = renderer.attach('stream')!
    previous.reachedHead()
    const reply = await renderer.read()
    rig.readers.handoff(renderer.endpoint)
    for (let generation = 2; generation <= count + 1; generation++) {
      renderer.reader.generation = generation
      const next = renderer.attach('stream')!
      previous.close()
      next.reachedHead()
      previous = next
    }
    expect(() => renderer.read()).toThrow()
    const replacement = await renderer.read(reply, { discarded: true })
    expect(replacement.streams[0]).toMatchObject({
      generation: count + 1,
      reset: { complete: true }
    })
    rig.readers.handoff(renderer.endpoint)
    previous.close()
    rig.readers.discard(renderer.endpoint, replacement.revision)
    const fleet = Array.from({ length: 256 }, (_, index) => rig.renderer().attach(String(index)))
    expect(fleet.every(Boolean)).toBe(true)
  } finally {
    await rig.dispose()
  }
})
