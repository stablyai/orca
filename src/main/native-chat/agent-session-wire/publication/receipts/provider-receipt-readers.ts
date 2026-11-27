import { randomUUID } from 'node:crypto'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  type ProviderReceiptRead,
  type ProviderReceiptReader,
  type ProviderReceiptReply
} from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type { StructuredAgentSessionProviderReceipts } from '../../host/structured-agent-session-provider-receipts'
import { ProviderReceiptStream } from './provider-receipt-stream'
import { encodeProviderReceiptFrame, fitProviderReceiptUpdates } from './provider-receipt-frame'

import {
  ProviderReceiptCredits,
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

  canBind(endpoint: ProviderReceiptDestination, identity?: ProviderReceiptReader): boolean {
    return this.credits.hasRoom(endpoint.transport) && this.ownsDocument(endpoint, identity)
  }

  private ownsDocument(
    endpoint: ProviderReceiptDestination,
    identity?: ProviderReceiptReader,
    exact = false
  ): boolean {
    const unread = this.credits.get(endpoint.transport)?.unread
    const generation = this.generations.get(endpoint.document)
    return (
      !endpoint.document.aborted &&
      !endpoint.transport.aborted &&
      (!unread || unread.document === endpoint.document) &&
      (!identity ||
        !generation ||
        (identity.id === generation.id &&
          (exact
            ? identity.generation === generation.generation
            : identity.generation >= generation.generation)))
    )
  }

  canStartRead(endpoint: ProviderReceiptDestination, identity: ProviderReceiptReader): boolean {
    return (
      this.canOpenPort(endpoint, identity) &&
      this.credits.get(endpoint.transport)?.reader?.document === endpoint.document
    )
  }

  canOpenPort(endpoint: ProviderReceiptDestination, identity: ProviderReceiptReader): boolean {
    return this.ownsDocument(endpoint, identity, true) && this.credits.hasRoom(endpoint.transport)
  }

  attach(
    endpoint: ProviderReceiptDestination,
    identity: ProviderReceiptReader,
    source: StructuredAgentSessionProviderReceipts,
    registration: { sessionId: string; subscription: string },
    cursor: () => AgentJournalCursor
  ): ProviderReceiptInterest | undefined {
    if (!this.canBind(endpoint, identity) || source.closed) {
      return undefined
    }
    const destination = this.credits.get(endpoint.transport)
    const previous = destination?.reader
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
    source: StructuredAgentSessionProviderReceipts | undefined,
    fixedFailure?: 'closed' | 'capacity',
    signal = endpoint.document
  ): Promise<ProviderReceiptReply> {
    if (signal.aborted || endpoint.document.aborted || endpoint.transport.aborted) {
      throw new Error('provider_receipt_sender_retired')
    }
    if (
      !this.ownsDocument(endpoint, input.reader, true) ||
      !this.credits.canContinue(endpoint, input.since)
    ) {
      throw new Error('provider_receipt_read_pending')
    }
    if (!this.credits.hasRoom(endpoint.transport)) {
      throw new Error('provider_receipt_capacity')
    }
    const target = (this.credits.get(endpoint.transport) ??
      this.credits.allocate(endpoint.transport))!
    if (target.unread) {
      this.credits.release(target, endpoint.document, input.since, input.discarded === true)
    }
    const reader = target.reader
    let failure: Wait['failure']
    if (fixedFailure) {
      failure = fixedFailure
    } else if (source?.closed) {
      failure = 'closed'
    } else if (input.hostIncarnation !== null && input.hostIncarnation !== source?.incarnation) {
      failure = 'host_restarted'
    } else if (
      !reader ||
      reader.source !== source ||
      reader.document !== endpoint.document ||
      reader.identity.id !== input.reader.id
    ) {
      failure =
        this.streamCount === MAX_PROVIDER_RECEIPT_STREAMS && !reader ? 'capacity' : 'reader_unknown'
    }
    if (!failure && !input.since && this.credits.consumed(endpoint.document) && reader) {
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
    signal.addEventListener('abort', abort, { once: true })
    const wait = {
      document: endpoint.document,
      reader,
      source,
      failure,
      resolve,
      reject,
      cancelled: () => signal.removeEventListener('abort', abort)
    }
    target.waiting = wait
    this.wake(target)
    return promise
  }

  canContinue = this.credits.canContinue.bind(this.credits)
  hasPostedReply = this.credits.hasPostedReply.bind(this.credits)
  discard = this.credits.discard.bind(this.credits)
  handoff = this.credits.handoff.bind(this.credits)
  suppress = this.credits.suppress.bind(this.credits)
  preparedReply = this.credits.preparedReply.bind(this.credits)
  retireDocument = this.credits.retireDocument.bind(this.credits)

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
    const sequence = (this.credits.consumed(wait.document)?.sequence ?? 0) + 1
    const makeReply = (): ProviderReceiptReply => ({
      status: wait.failure ?? 'changed',
      hostIncarnation: wait.source?.incarnation ?? this.absentIncarnation,
      revision: { sequence, nonce: randomUUID() },
      streams: []
    })
    const runtimeId = this.runtimeId()
    if (wait.failure) {
      const reply = makeReply()
      this.credits.deliver(target, wait, reply, encodeProviderReceiptFrame(runtimeId, reply))
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
      const complete = fitProviderReceiptUpdates(runtimeId, reply, frame, updates)
      const encoded = encodeProviderReceiptFrame(runtimeId, reply)
      if (
        encoded.byteLength > MAX_PROVIDER_RECEIPT_REPLY_BYTES ||
        (frame.updates.length === 0 && updates.length !== 0)
      ) {
        wait.failure = 'capacity'
        return this.wake(target)
      }
      member.stream.handedOff(frame, complete)
      member.staged = frame
      this.credits.deliver(target, wait, reply, encoded, {
        subscription: frame.subscription,
        token: member.token
      })
      return
    }
  }
}
