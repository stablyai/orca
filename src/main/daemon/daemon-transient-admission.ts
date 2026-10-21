import type { Socket } from 'node:net'
import type {
  TerminalTransientObservation,
  TerminalTransientSink
} from '../../shared/terminal-transient-observation'
import type { DaemonStreamFraming } from './daemon-stream-binary-framing'
import { TransientBinding } from './daemon-transient-binding'
import {
  TransientAccounting,
  type AdmittedTransientRecord,
  type RecordCounter,
  type SocketGeneration,
  type TransientEntryLease
} from './daemon-transient-accounting'
export { TransientEntryLease, type AdmittedTransientRecord } from './daemon-transient-accounting'
const BASE_BYTES = 512

/** The same ledger owns staged, queued and written records until the socket completes them. */
export class DaemonTransientAdmission extends TransientAccounting {
  private readonly bindings = new Map<string, TransientBinding>()
  private refill: ReturnType<typeof setTimeout> | null = null
  private cursor: IterableIterator<TransientBinding> | null = null
  private disposed = false
  private closed = false
  private generation: SocketGeneration = { records: 0, detach: () => {} }

  constructor(
    private socket: Socket,
    public framing: DaemonStreamFraming,
    private readonly enqueue: (sessionId: string, record: AdmittedTransientRecord) => void,
    private readonly removeQueued: (sessionId: string) => void,
    private readonly onIdle: () => void = () => {},
    private readonly onAvailable: () => void = () => {}
  ) {
    super()
    this.watchSocket()
  }

  protected get bindingCount(): number {
    return this.bindings.size
  }

  ownsSocket(socket: Socket | null | undefined): boolean {
    return !this.closed && this.socket === socket
  }

  get idle(): boolean {
    return this.closed && this.pending.size === 0 && this.bindings.size === 0
  }

  replaceSocket(socket: Socket, framing: DaemonStreamFraming): void {
    if (socket === this.socket) {
      return
    }
    if (this.generation.records === 0) {
      this.generation.detach()
    }
    this.socket = socket
    this.framing = framing
    this.generation = { records: 0, detach: () => {} }
    this.closed = false
    this.invalidateBindings()
    this.watchSocket()
  }

  private watchSocket(): void {
    const generation = this.generation
    const socket = this.socket
    const onClose = (): void => {
      if (this.generation === generation) {
        this.closed = true
        this.invalidateBindings()
        if (this.refill) {
          clearTimeout(this.refill)
        }
        this.refill = null
        this.cursor = null
      }
      for (const record of this.pending) {
        if (record.generation === generation) {
          record.release()
        }
      }
      if (this.idle) {
        this.onIdle()
      }
    }
    generation.detach = () => socket.removeListener('close', onClose)
    socket.once('close', onClose)
  }

  retained(): { bytes: number; records: number } {
    return { bytes: this.bytes, records: this.records }
  }

  canBind(sessionId: string, socket = this.socket): boolean {
    return (
      !this.disposed &&
      !socket.destroyed &&
      (socket !== this.socket ||
        (!this.closed && (this.bindings.has(sessionId) || this.bindings.size < 4096)))
    )
  }

  bind(
    sessionId: string,
    subscriptionId: string,
    streamId: string
  ): TerminalTransientSink | undefined {
    // Check post-replacement capacity before touching the predecessor.
    if (!this.canBind(sessionId)) {
      return undefined
    }
    const previous = this.bindings.get(sessionId)
    if (previous) {
      this.unbind(previous)
    }
    const binding = new TransientBinding(this, sessionId, subscriptionId, streamId)
    this.bytes += BASE_BYTES
    this.bindings.set(sessionId, binding)
    return binding
  }

  isObserving(sessionId: string): boolean {
    return this.bindings.get(sessionId)?.dirty === false
  }

  partition(
    sessionId: string,
    bytes: number,
    records = 1,
    query = false
  ): TransientEntryLease | undefined {
    const binding = this.bindings.get(sessionId)
    if (!binding || (binding.dirty && !query)) {
      return undefined
    }
    let lease = this.reserve(binding.counter, bytes, records, query)
    if (!lease) {
      this.lose(binding)
    }
    if (!lease && query) {
      lease = this.reserve(binding.counter, bytes, records, true)
    }
    return lease ?? undefined
  }

  retainedQueryChars(): number {
    let chars = 0
    for (const lease of this.pending) {
      chars += lease.queryChars
    }
    return chars
  }

  stage(binding: TransientBinding, observation: TerminalTransientObservation): void {
    if (!this.active(binding) || binding.dirty) {
      return
    }
    const record = binding.admit(observation)
    if (record) {
      binding.staged.push(record)
    } else {
      this.lose(binding)
    }
  }

  commit(binding: TransientBinding): void {
    while (binding.staged.length) {
      this.enqueue(binding.sessionId, binding.staged.shift()!)
    }
  }

  private active(binding: TransientBinding): boolean {
    return !this.disposed && this.bindings.get(binding.sessionId) === binding
  }

  discardQueued(counter: RecordCounter): void {
    for (const binding of this.bindings.values()) {
      if (binding.counter === counter) {
        this.lose(binding)
        return
      }
    }
  }

  startWrite(record: TransientEntryLease, socket: Socket): void {
    if (!this.pending.has(record) || record.generation) {
      return
    }
    this.replaceSocket(socket, this.framing)
    record.generation = this.generation
    this.generation.records++
  }

  release(record: TransientEntryLease): void {
    if (!this.pending.delete(record)) {
      return
    }
    this.bytes -= record.bytes
    record.counter.bytes -= record.bytes
    this.records -= record.records
    record.counter.records -= record.records
    if (record.generation) {
      record.generation.records--
      if (record.generation !== this.generation && record.generation.records === 0) {
        record.generation.detach()
      }
    }
    this.scheduleRefill()
    if (this.idle) {
      this.onIdle()
    }
  }

  install(binding: TransientBinding, current: TerminalTransientObservation): void {
    if (!this.active(binding)) {
      return
    }
    const record = binding.admit(current)
    if (!record) {
      binding.dirty = true
      return
    }
    // The canonical predecessor is charged once per install, never copied onto live display entries.
    const mapping = binding.admitEvent({
      type: 'event',
      event: 'data',
      sessionId: binding.sessionId,
      payload: { data: '', rawLength: 0, subscriptionId: binding.subscriptionId }
    })
    if (!mapping) {
      binding.dirty = true
      record.release()
      return
    }
    record.installBoundary = true
    mapping.installBoundary = true
    binding.dirty = false
    this.enqueue(binding.sessionId, record)
    this.enqueue(binding.sessionId, mapping)
  }

  private lose(binding: TransientBinding): void {
    binding.dirty = true
    binding.epoch++
    for (const record of binding.staged.splice(0)) {
      record.release()
    }
    this.removeQueued(binding.sessionId)
    this.scheduleRefill()
  }

  private scheduleRefill(): void {
    if (this.disposed || this.closed || this.refill) {
      return
    }
    this.refill = setTimeout(() => {
      this.refill = null
      this.onAvailable()
      this.cursor ??= this.bindings.values()
      for (let count = 0; count < 16; count++) {
        const next = this.cursor.next()
        if (next.done) {
          this.cursor = null
          break
        }
        const binding = next.value
        if (binding.dirty && !binding.unencodable && binding.readCurrent) {
          this.install(binding, binding.readCurrent())
        }
      }
      if (this.cursor) {
        this.scheduleRefill()
      }
    }, 0)
  }

  unbind(binding: TransientBinding): void {
    if (!this.active(binding)) {
      return
    }
    this.bindings.delete(binding.sessionId)
    binding.readCurrent = null
    for (const record of binding.staged.splice(0)) {
      record.release()
    }
    this.removeQueued(binding.sessionId)
    this.bytes -= BASE_BYTES
  }

  invalidateBindings(): void {
    for (const binding of this.bindings.values()) {
      this.unbind(binding)
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.invalidateBindings()
    this.disposed = true
    if (this.refill) {
      clearTimeout(this.refill)
    }
    this.refill = null
    this.cursor = null
    for (const record of this.pending) {
      if (!record.generation) {
        record.release()
      }
    }
  }
}
