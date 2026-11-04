import {
  TERMINAL_ORDERED_INPUT_MAX_BYTES,
  TERMINAL_ORDERED_INPUT_MAX_WAITERS,
  TERMINAL_ORDERED_INPUT_WINDOW,
  terminalOrderedInputControls,
  terminalOrderedInputByteLength
} from '../../../src/shared/terminal-ordered-input'
import { getTerminalInputByteLength } from '../../../src/shared/terminal-input'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { terminalInputSend, terminalInputSessionOpen } from './mobile-terminal-operations'
import { TERMINAL_LIVE_INPUT_MAX_BYTES } from './terminal-live-input'

import {
  refused,
  epoch,
  type TerminalInputEnqueueOptions,
  type Params,
  type Caller,
  type Batch,
  type Owner
} from './mobile-terminal-input-owner'
export type { TerminalInputEnqueueOptions } from './mobile-terminal-input-owner'

export class MobileTerminalInputSender {
  private readonly owners = new Map<string, Owner>()
  private client: RpcClient | null = null
  private bytes = 0
  private waiters = 0
  private active = 0

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
    if (this.client !== client) {
      for (const owner of this.owners.values()) {
        this.fail(owner)
      }
      this.owners.clear()
      this.client = client
    }
    let owner = this.owners.get(params.terminal)
    if (owner && owner.epoch !== epoch(client)) {
      this.fail(owner)
      this.owners.delete(params.terminal)
      owner = undefined
    }
    if (owner?.failed) {
      if (owner.active.size || owner.opening) {
        return this.refuse(params.terminal, enqueue)
      }
      capable = owner.strict
      this.owners.delete(params.terminal)
      owner = undefined
    }
    if (!owner) {
      if (this.owners.size >= 64) {
        const idle = [...this.owners].find(
          ([, entry]) => !entry.active.size && !entry.pending.length && !entry.opening
        )
        if (!idle) {
          return this.refuse(params.terminal, enqueue)
        }
        this.owners.delete(idle[0])
      }
      owner = {
        client,
        handle: params.terminal,
        epoch: epoch(client),
        strict: capable,
        token: null,
        seq: 0,
        pending: [],
        active: new Set(),
        opening: false,
        failed: false
      }
      this.owners.set(params.terminal, owner)
    }
    if (owner.strict) {
      params = { ...params, ...terminalOrderedInputControls(params) }
    }
    const bytes = terminalOrderedInputByteLength(params)
    if (
      this.waiters >= TERMINAL_ORDERED_INPUT_MAX_WAITERS ||
      this.bytes + bytes > TERMINAL_ORDERED_INPUT_MAX_BYTES
    ) {
      this.fail(owner)
      return this.refuse(params.terminal, enqueue)
    }
    const target = owner
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
      options: { ...enqueue, signal },
      cleanup: () => signal?.removeEventListener('abort', abort)
    }
    this.bytes += bytes
    this.waiters += 1
    const tail = target.pending.at(-1)
    if (
      tail &&
      options === tail.options &&
      !options?.beforeSend &&
      kind !== 'control' &&
      tail.kind === kind &&
      [tail.params, params].every((input) =>
        Object.keys(input).every((key) => ['terminal', 'text', 'enter', 'client'].includes(key))
      ) &&
      tail.params.client?.id === params.client?.id &&
      tail.params.client?.type === params.client?.type &&
      getTerminalInputByteLength(tail.params.text ?? '') + bytes <= TERMINAL_LIVE_INPUT_MAX_BYTES
    ) {
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
      this.waiters -= 1
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
        caller.resolve(refused(owner.handle))
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
      this.finish(batch, owner.failed ? refused(owner.handle) : reply)
      owner.active.delete(batch)
      this.active -= 1
      this.pump()
    }
  }
}
