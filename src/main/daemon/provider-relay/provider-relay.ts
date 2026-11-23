import type { ManagedProviderProcess } from '../../provider-process/managed-provider-process'
import type {
  ProviderRelayAttachResult,
  ProviderRelayExit,
  ProviderRelayInfo,
  ProviderRelayRecord
} from '../protocol/daemon-provider-relay-protocol'
import { ProviderRelayPendingRequests } from './provider-relay-pending-requests'
import { ProviderRelaySpool } from './provider-relay-spool'
import { streamFramesFor } from '../transport/framing/daemon-stream-data-split'
import type { DaemonStreamFraming } from '../transport/framing/daemon-stream-binary-framing'

const NEWLINE = 0x0a
/** Keeps each event frame well under the stream's line cap even after JSON escaping. */
const EVENT_PIECE_CHARS = 1024 * 1024

type RelayOptions = {
  relayId: string
  chatKey: string
  managed: ManagedProviderProcess
  spoolPath: string
  onExit: () => void
  /** No client is attached anymore; an ended relay may now expire. */
  onDetached: () => void
}

/** The client's event stream; its close detaches the relay, as a closing stream detaches a PTY. */
export type ProviderRelayStream = {
  socket: {
    write(chunk: string | Uint8Array): unknown
    once(event: 'close' | 'drain', listener: () => void): unknown
    off(event: 'close' | 'drain', listener: () => void): unknown
    readonly destroyed: boolean
    readonly writableNeedDrain?: boolean
  }
  framing?: DaemonStreamFraming
}

type Attachment = ProviderRelayStream & { clientId: string; onClose: () => void }

/** One daemon-owned agent: its stdout spool, unanswered requests, and the one client attached. */
export class ProviderRelay {
  readonly relayId: string
  readonly chatKey: string
  readonly spawnedAtMs = Date.now()
  readonly pending = new ProviderRelayPendingRequests()
  private readonly spool: ProviderRelaySpool
  private attachment: Attachment | null = null
  private partial: Buffer[] = []
  private exitStatus: ProviderRelayExit | null = null
  private stdoutEnded = false
  private exitAnnounced = false

  constructor(private readonly options: RelayOptions) {
    this.relayId = options.relayId
    this.chatKey = options.chatKey
    const stdout = options.managed.child.stdout
    this.spool = new ProviderRelaySpool({
      path: options.spoolPath,
      deliver: (record) => this.deliver(record),
      onPressureChanged: (paused) => (paused ? stdout.pause() : stdout.resume()),
      drained: () => this.drained()
    })
    stdout.on('data', (chunk: Buffer) => this.readStdout(chunk))
    stdout.once('end', () => {
      this.flushPartial()
      this.stdoutEnded = true
      this.announceExitIfDone()
      // A trailing line flushed after exit may have reopened the spool.
      if (!this.live && !this.attachment) {
        this.spool.closeHandle()
      }
    })
    stdout.on('error', () => {})
    options.managed.child.stdin.on('error', () => {})
    options.managed.onExit((exit) => {
      this.exitStatus = { code: exit.code, signal: exit.signal }
      this.pending.clear()
      // A processless or lost-outcome exit may never end stdout; it has nothing more to say.
      if (exit.processless) {
        this.stdoutEnded = true
      }
      this.announceExitIfDone()
      if (!this.attachment) {
        this.spool.closeHandle()
      }
      options.onExit()
    })
  }

  get live(): boolean {
    return this.exitStatus === null
  }

  get attachedClientId(): string | null {
    return this.attachment?.clientId ?? null
  }

  /** Ended and fully acked: nothing left that a client could still need. */
  get finished(): boolean {
    return this.exitStatus !== null && this.stdoutEnded && this.spool.drained
  }

  async attach(
    clientId: string,
    stream: ProviderRelayStream,
    fromSeq: number
  ): Promise<ProviderRelayAttachResult> {
    this.release()
    const attachment: Attachment = {
      ...stream,
      clientId,
      onClose: () => void this.detach(clientId)
    }
    this.attachment = attachment
    stream.socket.once('close', attachment.onClose)
    const replayThroughSeq = await this.spool.attach(fromSeq)
    if (this.attachment === attachment && this.exitAnnounced) {
      this.sendExit()
    }
    return {
      replayThroughSeq,
      pending: this.pending.records(),
      maxClientRequestId: this.pending.maxClientRequestId,
      initializeResult: this.pending.initializeResult,
      stderrTail: this.options.managed.stderrTail(),
      exit: this.exitStatus
    }
  }

  detach(clientId?: string): Promise<void> {
    if (clientId !== undefined && this.attachedClientId !== clientId) {
      return Promise.resolve()
    }
    this.release()
    const detached = this.spool.detach()
    if (!this.live) {
      this.spool.closeHandle()
    }
    this.options.onDetached()
    return detached
  }

  write(data: string): void {
    this.pending.observeClientData(data)
    this.options.managed.child.stdin.write(data)
  }

  ack(seq: number): void {
    this.spool.ack(seq)
  }

  close(grace?: 'brief'): Promise<unknown> {
    return this.options.managed.close(undefined, grace === 'brief' ? { grace } : undefined)
  }

  info(): ProviderRelayInfo {
    return {
      relayId: this.relayId,
      chatKey: this.chatKey,
      pid: this.options.managed.child.pid ?? null,
      spawnedAtMs: this.spawnedAtMs,
      attached: this.attachment !== null,
      exit: this.exitStatus,
      nextSeq: this.spool.nextSeq,
      ackedSeq: this.spool.ackedSeq,
      pendingCount: this.pending.size
    }
  }

  async dispose(): Promise<void> {
    this.release()
    if (this.live) {
      // stdin end starts provider-exec's own close ladder; owner death would start the same one.
      void this.close().catch(() => {})
    }
    await this.spool.dispose()
  }

  private readStdout(chunk: Buffer): void {
    let start = 0
    let newline = chunk.indexOf(NEWLINE, start)
    while (newline !== -1) {
      const tail = chunk.subarray(start, newline)
      const line =
        this.partial.length === 0
          ? tail.toString('utf8')
          : Buffer.concat([...this.partial, tail]).toString('utf8')
      this.partial = []
      this.appendLine(line)
      start = newline + 1
      newline = chunk.indexOf(NEWLINE, start)
    }
    if (start < chunk.length) {
      this.partial.push(chunk.subarray(start))
    }
  }

  private flushPartial(): void {
    if (this.partial.length > 0) {
      const line = Buffer.concat(this.partial).toString('utf8')
      this.partial = []
      this.appendLine(line)
    }
  }

  private appendLine(line: string): void {
    // Observe before append so a reattaching client sees the request in the pending table.
    const seq = this.spool.nextSeq
    this.pending.observeAgentLine({ seq, line })
    this.spool.append(line)
  }

  private release(): void {
    this.attachment?.socket.off('close', this.attachment.onClose)
    this.attachment = null
  }

  private drained(): Promise<void> {
    const socket = this.attachment?.socket
    if (!socket?.writableNeedDrain || socket.destroyed) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const done = (): void => {
        socket.off('drain', done)
        socket.off('close', done)
        resolve()
      }
      socket.once('drain', done)
      socket.once('close', done)
    })
  }

  private send(event: unknown): void {
    const attachment = this.attachment
    if (attachment && !attachment.socket.destroyed) {
      attachment.socket.write(streamFramesFor(attachment.framing).control(event))
    }
  }

  private deliver(record: ProviderRelayRecord): void {
    const { seq, line } = record
    if (line.length <= EVENT_PIECE_CHARS) {
      this.send(this.dataEvent(seq, line))
      return
    }
    for (let offset = 0; offset < line.length; offset += EVENT_PIECE_CHARS) {
      const end = offset + EVENT_PIECE_CHARS
      this.send(this.dataEvent(seq, line.slice(offset, end), end < line.length))
    }
  }

  private dataEvent(seq: number, line: string, more = false) {
    return {
      type: 'event',
      event: 'relayData',
      sessionId: this.relayId,
      payload: more ? { seq, line, more: true } : { seq, line }
    }
  }

  private announceExitIfDone(): void {
    if (this.exitAnnounced || this.exitStatus === null || !this.stdoutEnded) {
      return
    }
    this.exitAnnounced = true
    if (this.attachment && this.spool.streaming) {
      this.sendExit()
    }
  }

  private sendExit(): void {
    this.send({
      type: 'event',
      event: 'relayExit',
      sessionId: this.relayId,
      payload: this.exitStatus
    })
  }
}
