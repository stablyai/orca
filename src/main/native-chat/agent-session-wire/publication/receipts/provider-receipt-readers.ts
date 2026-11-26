import { randomUUID } from 'node:crypto'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  MAX_PROVIDER_RECEIPT_REPLY_KEYS,
  type ProviderReceiptRead,
  type ProviderReceiptReader,
  type ProviderReceiptReply
} from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type { StructuredAgentSessionProviderReceipts } from '../../host/structured-agent-session-provider-receipts'
import { ProviderReceiptStream } from './provider-receipt-stream'

import {
  ProviderReceiptCredits,
  sameCursor,
  type Destination,
  type Membership,
  type ProviderReceiptDestination,
  type Reader,
  type Wait
} from './provider-receipt-credits'

const MAX_PROVIDER_RECEIPT_STREAMS = 256

export type ProviderReceiptInterest = {
  reachedHead: () => void
  close: () => void
}

export class ProviderReceiptReaders {
  private readonly credits = new ProviderReceiptCredits((target) => this.wake(target))
  private readonly generations = new WeakMap<AbortSignal, ProviderReceiptReader>()
  private readonly absentIncarnation = randomUUID()
  private streamCount = 0

  constructor(private readonly runtimeId: () => string) {}

  attach(
    endpoint: ProviderReceiptDestination,
    identity: ProviderReceiptReader,
    source: StructuredAgentSessionProviderReceipts,
    registration: { sessionId: string; subscription: string },
    cursor: () => AgentJournalCursor
  ): ProviderReceiptInterest | undefined {
    if (endpoint.document.aborted || endpoint.transport.aborted || source.closed) {
      return undefined
    }
    const destination = this.credits.get(endpoint.transport)
    if (destination?.unread && destination.unread.document !== endpoint.document) {
      return undefined
    }
    const previous = destination?.reader
    const generation = this.generations.get(endpoint.document)
    if (
      generation &&
      (identity.id !== generation.id || identity.generation < generation.generation)
    ) {
      return undefined
    }
    const replace = previous?.streams.get(registration.subscription)
    if (this.streamCount >= MAX_PROVIDER_RECEIPT_STREAMS && !replace) {
      return undefined
    }
    const target = destination ?? this.credits.allocate(endpoint.transport)
    if (!target) {
      return undefined
    }
    const reader: Reader =
      previous?.document === endpoint.document &&
      previous.source === source &&
      previous.identity.generation === identity.generation
        ? previous
        : { source, document: endpoint.document, identity, streams: new Map(), ready: new Set() }
    if (previous && reader !== previous) {
      if (target.waiting?.reader === previous) {
        target.waiting.failure = 'superseded'
      }
      target.reader = reader
      for (const member of previous.streams.values()) {
        member.close()
      }
    }
    target.reader = reader
    this.generations.set(endpoint.document, identity)
    const stream = new ProviderReceiptStream(
      source,
      registration.sessionId,
      registration.subscription,
      identity.generation,
      cursor
    )
    const stop = source.watch(registration.sessionId, (id, closed) => {
      if (closed) {
        if (target.waiting?.reader === reader) {
          target.waiting.failure = 'closed'
        }
        member.close()
      } else {
        stream.changed(id)
        this.ready(target, reader, member)
      }
    })
    let closed = false
    const member: Membership = {
      stream,
      token: Symbol(),
      close: () => {
        if (closed) {
          return
        }
        closed = true
        member.staged = undefined
        stream.discard()
        stop()
        if (reader.streams.get(registration.subscription) === member) {
          reader.streams.delete(registration.subscription)
        }
        reader.ready.delete(member)
        this.streamCount--
        if (reader.streams.size === 0 && target.reader === reader) {
          target.reader = undefined
          if (target.waiting?.reader === reader) {
            target.waiting.failure ??= 'detached'
          }
        }
        this.wake(target)
        this.credits.prune(target)
      }
    }
    reader.streams.set(registration.subscription, member)
    this.streamCount++
    replace?.close()
    this.wake(target)
    return {
      reachedHead: () => {
        const { epoch } = cursor()
        if (member.epoch !== epoch && reader.streams.get(registration.subscription) === member) {
          member.epoch = epoch
          this.ready(target, reader, member)
        }
      },
      close: member.close
    }
  }

  read(
    endpoint: ProviderReceiptDestination,
    input: ProviderReceiptRead,
    source: StructuredAgentSessionProviderReceipts | undefined
  ): Promise<ProviderReceiptReply> {
    if (endpoint.document.aborted || endpoint.transport.aborted) {
      throw new Error('provider_receipt_sender_retired')
    }
    const target = this.credits.get(endpoint.transport) ?? this.credits.allocate(endpoint.transport)
    if (!target) {
      throw new Error('provider_receipt_capacity')
    }
    if (target.waiting) {
      target.waiting.failure = 'superseded'
      this.wake(target)
      throw new Error('provider_receipt_read_pending')
    }
    if (
      target.unread &&
      !this.credits.release(target, endpoint.document, input.since, input.discarded === true)
    ) {
      throw new Error('provider_receipt_read_pending')
    }
    const reader = target.reader
    const generation = this.generations.get(endpoint.document)
    let failure: Wait['failure']
    if (source?.closed) {
      failure = 'closed'
    } else if (input.hostIncarnation !== null && input.hostIncarnation !== source?.incarnation) {
      failure = 'host_restarted'
    } else if (
      generation?.id === input.reader.id &&
      input.reader.generation < generation.generation
    ) {
      failure = 'superseded'
    } else if (
      (input.since && !sameCursor(input.since, target.consumed ?? null)) ||
      !reader ||
      reader.source !== source ||
      reader.document !== endpoint.document ||
      reader.identity.id !== input.reader.id
    ) {
      failure =
        this.streamCount === MAX_PROVIDER_RECEIPT_STREAMS && !reader ? 'capacity' : 'reader_unknown'
    } else if (reader.identity.generation !== input.reader.generation) {
      failure = 'superseded'
    }
    if (!failure && !input.since && target.consumed && reader) {
      for (const member of reader.streams.values()) {
        member.stream.discard()
        this.ready(target, reader, member)
      }
    }
    const { resolve, reject, promise } = Promise.withResolvers<ProviderReceiptReply>()
    const abort = (): void => {
      this.credits.stopWait(target)
      reject(new Error('provider_receipt_sender_retired'))
      this.credits.prune(target)
    }
    endpoint.document.addEventListener('abort', abort, { once: true })
    const wait = {
      document: endpoint.document,
      reader,
      source,
      failure,
      resolve,
      reject,
      cancelled: () => {
        endpoint.document.removeEventListener('abort', abort)
      }
    }
    target.waiting = wait
    this.wake(target)
    return promise
  }

  discard = this.credits.discard.bind(this.credits)
  handoff = this.credits.handoff.bind(this.credits)
  suppress = this.credits.suppress.bind(this.credits)

  private ready(target: Destination, reader: Reader, member: Membership): void {
    if (member.epoch !== undefined && reader.streams.get(member.stream.subscription) === member) {
      reader.ready.add(member)
      if (target.waiting && !target.scheduled && !this.credits.isBlocked(target)) {
        target.scheduled = true
        queueMicrotask(() => {
          target.scheduled = undefined
          this.wake(target)
        })
      }
    }
  }

  private wake(target: Destination): void {
    const wait = target.waiting
    if (!wait || (!wait.failure && this.credits.isBlocked(target))) {
      return
    }
    const makeReply = (): ProviderReceiptReply => ({
      status: wait.failure ?? 'changed',
      hostIncarnation: wait.source?.incarnation ?? this.absentIncarnation,
      revision: { sequence: (target.consumed?.sequence ?? 0) + 1, nonce: randomUUID() },
      streams: []
    })
    if (wait.failure) {
      const reply = makeReply()
      this.credits.deliver(target, wait, reply, this.bytes(reply))
      return
    }
    const reader = wait.reader!
    if (!reader.ready.size) {
      return
    }
    if (this.credits.parkIfFull(target)) {
      return
    }
    for (const member of reader.ready) {
      reader.ready.delete(member)
      const prepared = member.stream.prepare()
      if (!prepared) {
        continue
      }
      const { frame, updates } = prepared
      const reply = makeReply()
      reply.streams.push(frame)
      let bytes = this.bytes(reply)
      for (const update of updates) {
        const appended = Buffer.byteLength(JSON.stringify(update)) + (frame.updates.length ? 1 : 0)
        if (
          bytes + appended > MAX_PROVIDER_RECEIPT_REPLY_BYTES ||
          frame.updates.length === MAX_PROVIDER_RECEIPT_REPLY_KEYS
        ) {
          break
        }
        frame.updates.push(update)
        bytes += appended
      }
      if (frame.updates.length === 0 && updates.length !== 0) {
        wait.failure = 'capacity'
        return this.wake(target)
      }
      const complete = frame.updates.length === updates.length
      if (frame.reset) {
        frame.reset.complete = complete
      }
      member.stream.handedOff(frame, complete)
      member.staged = frame
      this.credits.deliver(target, wait, reply, this.bytes(reply), {
        subscription: frame.subscription,
        token: member.token
      })
      return
    }
  }

  private bytes(reply: ProviderReceiptReply): number {
    return Buffer.byteLength(
      JSON.stringify({
        id: 'desktop-ipc',
        ok: true,
        result: reply,
        _meta: { runtimeId: this.runtimeId() }
      })
    )
  }
}
