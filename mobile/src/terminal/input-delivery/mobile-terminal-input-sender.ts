import {
  TERMINAL_ORDERED_INPUT_MAX_BYTES,
  TERMINAL_ORDERED_INPUT_MAX_WAITERS,
  TERMINAL_ORDERED_INPUT_WINDOW,
  terminalOrderedInputControls,
  terminalOrderedInputByteLength
} from '../../../../src/shared/terminal/input/terminal-ordered-input'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { SendRequestOptions } from '../../transport/rpc/unvalidated-rpc-request-port'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import {
  terminalInputSend,
  terminalInputSessionOpen
} from '../host-operations/mobile-terminal-operations'

import {
  acquireTerminalInputOwner,
  canMergeTerminalInputBatch,
  refused,
  epoch,
  type TerminalInputEnqueueOptions,
  type Params,
  type Caller,
  type Batch,
  type Owner
} from './mobile-terminal-input-owner'

export class MobileTerminalInputSender {
  private readonly owners = new Map<string, Owner>()
  private client: RpcClient | null = null
  private bytes = 0
  private waiters = 0
  private active = 0

  private acquireOwner(client: RpcClient, terminal: string, capable: boolean): Owner | null {
    if (this.client !== client) {
      for (const owner of this.owners.values()) {
        this.fail(owner)
      }
      this.owners.clear()
      this.client = client
    }
    return acquireTerminalInputOwner(this.owners, client, terminal, capable, (owner) =>
      this.fail(owner)
    )
  }

  request(
    client: RpcClient,
    params: Params,
    options: SendRequestOptions | undefined,
    capable: boolean,
    enqueue: TerminalInputEnqueueOptions = {}
  ): Promise<RpcResponse> {
    if (client.getState() !== 'connected' || enqueue.signal?.aborted || options?.signal?.aborted) {
      return this.refuse(params.terminal, enqueue)
    }
    const target = this.acquireOwner(client, params.terminal, capable)
    if (!target) {
      return this.refuse(params.terminal, enqueue)
    }
    if (target.strict) {
      params = { ...params, ...terminalOrderedInputControls(params) }
    }
    const bytes = terminalOrderedInputByteLength(params)
    if (
      this.waiters >= TERMINAL_ORDERED_INPUT_MAX_WAITERS ||
      this.bytes + bytes > TERMINAL_ORDERED_INPUT_MAX_BYTES
    ) {
      this.fail(target)
      return this.refuse(params.terminal, enqueue)
    }
    const kind =
      enqueue.gestureDeadline !== undefined
        ? 'gesture'
        : enqueue.control || params.enter || params.interrupt
          ? 'control'
          : 'text'
    let resolve!: (reply: RpcResponse) => void
    const delivery = new Promise<RpcResponse>((done) => {
      resolve = done
    })
    const abort = () => this.fail(target)
    const signal = enqueue.signal ?? options?.signal
    signal?.addEventListener('abort', abort, { once: true })
    const caller: Caller = {
      resolve,
      bytes,
      waiters: 1,
      options: { ...enqueue, signal },
      cleanup: () => signal?.removeEventListener('abort', abort)
    }
    this.bytes += bytes
    this.waiters += 1
    const tail = target.pending.at(-1)
    if (canMergeTerminalInputBatch(tail, params, options, kind, bytes)) {
      tail.params = { ...tail.params, text: (tail.params.text ?? '') + (params.text ?? '') }
      tail.callers.push(caller)
      tail.deadline = enqueue.gestureDeadline
    } else {
      target.pending.push({
        params,
        options,
        kind,
        deadline: enqueue.gestureDeadline,
        callers: [caller]
      })
    }
    try {
      enqueue.onAdmission?.(true)
    } catch {
      this.fail(target)
    }
    this.pump()
    return delivery
  }

  /** Enqueues a multi-chunk paste atomically as 1 waiter with no tail merging so frames stay within cap and cannot interleave. */
  requestSequence(
    client: RpcClient,
    chunks: readonly Params[],
    options: SendRequestOptions | undefined,
    capable: boolean
  ): Promise<RpcResponse[]> {
    if (chunks.length === 0) {
      return Promise.resolve([])
    }
    const terminal = chunks[0].terminal
    const refuseAll = () => Promise.resolve(chunks.map(() => refused(terminal)))
    if (client.getState() !== 'connected' || options?.signal?.aborted) {
      return refuseAll()
    }
    const target = this.acquireOwner(client, terminal, capable)
    if (!target) {
      return refuseAll()
    }
    const normalized = chunks.map((chunk) =>
      target.strict ? { ...chunk, ...terminalOrderedInputControls(chunk) } : chunk
    )
    const chunkBytes = normalized.map((chunk) => terminalOrderedInputByteLength(chunk))
    const totalBytes = chunkBytes.reduce((sum, size) => sum + size, 0)
    if (
      this.waiters >= TERMINAL_ORDERED_INPUT_MAX_WAITERS ||
      this.bytes + totalBytes > TERMINAL_ORDERED_INPUT_MAX_BYTES
    ) {
      return refuseAll()
    }
    this.bytes += totalBytes
    this.waiters += 1
    const deliveries = normalized.map((params, index) => {
      let resolve!: (reply: RpcResponse) => void
      const delivery = new Promise<RpcResponse>((done) => {
        resolve = done
      })
      const caller: Caller = {
        resolve,
        bytes: chunkBytes[index],
        waiters: index === normalized.length - 1 ? 1 : 0,
        resolveOnFinish: true,
        options: {},
        cleanup: () => {}
      }
      target.pending.push({ params, options, kind: 'paste', callers: [caller] })
      return delivery
    })
    this.pump()
    return Promise.all(deliveries)
  }

  private refuse(handle: string, enqueue: TerminalInputEnqueueOptions): Promise<RpcResponse> {
    enqueue.onAdmission?.(false)
    return Promise.resolve(refused(handle))
  }

  cancelAll(): void {
    for (const owner of this.owners.values()) {
      this.fail(owner)
    }
  }

  private current(owner: Owner): boolean {
    return (
      !owner.failed &&
      owner.client.getState() === 'connected' &&
      owner.epoch === epoch(owner.client)
    )
  }

  private finish(batch: Batch, reply: RpcResponse): void {
    for (const caller of batch.callers) {
      caller.cleanup()
      this.bytes -= caller.bytes
      this.waiters -= caller.waiters
      caller.resolve(reply)
    }
    batch.callers = []
  }

  private fail(owner: Owner): void {
    owner.failed = true
    for (const batch of owner.pending.splice(0)) {
      this.finish(batch, refused(owner.handle))
    }
    // Issued work retains its budget until the actual request settles, even after a field cancels.
    for (const batch of owner.active) {
      for (const caller of batch.callers) {
        if (!caller.resolveOnFinish) {
          caller.resolve(refused(owner.handle))
        }
      }
    }
  }

  private pump(): void {
    for (const owner of this.owners.values()) {
      if (!this.current(owner)) {
        this.fail(owner)
        continue
      }
      if (owner.strict && !owner.token && owner.pending.length && !owner.opening) {
        void this.open(owner)
      }
      while (
        this.current(owner) &&
        owner.pending.length &&
        this.active < TERMINAL_ORDERED_INPUT_WINDOW &&
        owner.active.size < (owner.strict ? TERMINAL_ORDERED_INPUT_WINDOW : 1) &&
        (!owner.strict || owner.token)
      ) {
        const batch = owner.pending.shift()!
        if (batch.deadline !== undefined && batch.deadline < Date.now()) {
          this.finish(batch, refused(owner.handle))
          continue
        }
        if (
          batch.callers.some(
            ({ options }) => options.signal?.aborted || options.isCurrent?.() === false
          )
        ) {
          this.finish(batch, refused(owner.handle))
          this.fail(owner)
          break
        }
        owner.active.add(batch)
        this.active += 1
        void this.deliver(owner, batch)
      }
    }
  }

  private async open(owner: Owner): Promise<void> {
    owner.opening = true
    try {
      const client = owner.pending[0].params.client
      if (client?.type !== 'mobile') {
        throw new Error('terminal_input_missing_identity')
      }
      const reply = await terminalInputSessionOpen.request(
        owner.client,
        { terminal: owner.handle, client: { id: client.id, type: 'mobile' } },
        { failWhenDisconnected: true }
      )
      const token = terminalInputSessionOpen.interpret(reply)
      if (this.current(owner) && token) {
        owner.token = token
      } else {
        this.fail(owner)
      }
    } catch {
      this.fail(owner)
    } finally {
      owner.opening = false
      this.pump()
    }
  }

  private async deliver(owner: Owner, batch: Batch): Promise<void> {
    let reply = refused(owner.handle)
    try {
      const params = owner.strict
        ? { ...batch.params, inputSequence: { sessionId: owner.token!, seq: ++owner.seq } }
        : batch.params
      reply = await terminalInputSend.request(owner.client, params, {
        ...batch.options,
        signal: undefined,
        failWhenDisconnected: true,
        beforeSend: () => {
          if (
            !this.current(owner) ||
            batch.callers.some(
              ({ options }) => options.signal?.aborted || options.isCurrent?.() === false
            )
          ) {
            throw new Error('terminal_input_retired')
          }
          batch.options?.beforeSend?.()
        }
      })
      if (!this.current(owner) || terminalInputSend.interpret(reply) !== true) {
        this.fail(owner)
      }
    } catch {
      this.fail(owner)
    } finally {
      owner.active.delete(batch)
      this.active -= 1
      this.finish(batch, owner.failed ? refused(owner.handle) : reply)
      this.pump()
    }
  }
}
