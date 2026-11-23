import type { ManagedProviderProcess } from '../../provider-process/managed-provider-process'
import type {
  ProviderRelayAttachResult,
  ProviderRelayExit,
  ProviderRelayFailure,
  ProviderRelayInfo,
  ProviderRelayRecord
} from '../protocol/daemon-provider-relay-protocol'
import { ProviderRelayPendingRequests } from './provider-relay-pending-requests'
import { ProviderRelaySpool } from './provider-relay-spool'
import { ProviderRelayLineReader } from './provider-relay-line-reader'
import { unlink } from 'node:fs/promises'
import { ProviderRelayAttachment, type ProviderRelayStream } from './provider-relay-attachment'

const MAX_QUEUED_INPUT_BYTES = 16 * 1024 * 1024
const RELAY_TAKEN_OVER = 'Relay attach superseded by a detach or another attach'

type RelayOptions = {
  relayId: string
  chatKey: string
  managed: ManagedProviderProcess
  spoolPath: string
  /** Test seam; defaults to the reader's own spill size. */
  lineSpillBytes?: number
  log?: (event: string, details?: Record<string, unknown>) => void
  /** The agent exited or its stdout ended: the record may now be finished or expire. */
  onSettled: () => void
  /** No client is attached anymore; an ended relay may now expire. */
  onDetached: () => void
}

/** One daemon-owned agent: its stdout spool, unanswered requests, and the one client attached. */
export class ProviderRelay {
  readonly relayId: string
  readonly chatKey: string
  readonly spawnedAtMs = Date.now()
  readonly pending = new ProviderRelayPendingRequests()
  private readonly spool: ProviderRelaySpool
  private attachment: ProviderRelayAttachment | null = null
  private readonly lines: ProviderRelayLineReader
  private readerBusy = false
  private exitStatus: ProviderRelayExit | null = null
  private stdoutEnded = false
  private exitAnnounced = false
  private spoolPaused = false
  private readingPaused = false
  private failure: ProviderRelayFailure | null = null
  /** The relay is kept until a client was actually sent its exit, so no outcome goes unseen. */
  private exitDelivered = false

  constructor(private readonly options: RelayOptions) {
    this.relayId = options.relayId
    this.chatKey = options.chatKey
    const stdout = options.managed.child.stdout
    this.spool = new ProviderRelaySpool({
      path: options.spoolPath,
      deliver: (record) => this.deliver(record),
      onPressureChanged: (paused) => {
        this.spoolPaused = paused
        this.updateReading()
      },
      drained: () => this.attachment?.drained() ?? Promise.resolve(),
      onFileLost: () => this.fail('spool-unreadable')
    })
    this.lines = new ProviderRelayLineReader({
      spillPath: `${options.spoolPath}.line`,
      onLine: (line, bytes) => this.appendLine(line, bytes),
      onBusy: (busy) => {
        this.readerBusy = busy
        this.updateReading()
      },
      ...(options.lineSpillBytes ? { spillBytes: options.lineSpillBytes } : {}),
      onLargeLine: (bytes) =>
        options.log?.('relay-large-line', { relayId: options.relayId, bytes }),
      onFailed: (reason) => this.fail(reason)
    })
    stdout.on('data', (chunk: Buffer) => this.lines.push(chunk))
    // A read error ends the output as surely as EOF; either way the exit can then be announced.
    let ending = false
    const endOutput = (): void => {
      if (!ending) {
        ending = true
        void this.lines.end().then(() => this.stdoutDone())
      }
    }
    stdout.once('end', endOutput)
    stdout.on('error', endOutput)
    options.managed.child.stdin.on('error', () => {})
    options.managed.onExit((exit) => {
      this.exitStatus = {
        code: exit.code,
        signal: exit.signal,
        ...(this.failure ? { error: this.failure } : {})
      }
      this.pending.clear()
      // Held requests no longer hold output back; the tail and stdout end must still drain.
      this.updateReading()
      // A processless or lost-outcome exit may never end stdout; it has nothing more to say.
      if (exit.processless) {
        this.stdoutEnded = true
      }
      this.announceExitIfDone()
      if (!this.attachment) {
        this.spool.closeHandle()
      }
      options.onSettled()
    })
  }

  get live(): boolean {
    return this.exitStatus === null
  }

  get attachedClientId(): string | null {
    return this.attachment?.clientId ?? null
  }

  /** Ended, its exit sent to a client and fully acked: nothing left that a client could still need. */
  get finished(): boolean {
    return this.exitDelivered && this.stdoutEnded && this.spool.drained
  }

  async attach(
    clientId: string,
    stream: ProviderRelayStream,
    fromSeq: number
  ): Promise<ProviderRelayAttachResult> {
    this.release()
    // Live records wait for this attach's own replay, or they would reach the new client twice.
    this.spool.suspend()
    const attachment = new ProviderRelayAttachment(
      clientId,
      stream,
      this.relayId,
      () => void this.detach(clientId)
    )
    this.attachment = attachment
    // The initialize answer and held requests go first, as events, so no reply line has to carry them.
    const { initializeResult } = this.pending
    const pending = this.pending.records()
    const sent =
      (initializeResult === null ||
        (await attachment.sendPieces('relayInitialize', 0, initializeResult))) &&
      (await this.sendEach(attachment, pending))
    // A detach or takeover during the preamble owns the spool now; this attach must not touch it.
    if (!sent || this.attachment !== attachment) {
      throw new Error(RELAY_TAKEN_OVER)
    }
    let replayThroughSeq: number
    try {
      replayThroughSeq = await this.spool.attach(fromSeq)
    } catch (error) {
      if (this.attachment === attachment) {
        void this.detach(clientId)
      }
      throw error
    }
    // A superseded attach claims nothing: its client must not save a cursor past what it was sent.
    if (this.attachment !== attachment) {
      throw new Error(RELAY_TAKEN_OVER)
    }
    if (this.exitAnnounced) {
      this.sendExit()
    }
    return this.attachResult(replayThroughSeq, pending, initializeResult !== null)
  }

  private async sendEach(
    attachment: ProviderRelayAttachment,
    records: ProviderRelayRecord[]
  ): Promise<boolean> {
    for (const { seq, line } of records) {
      if (!(await attachment.sendPieces('relayPending', seq, line))) {
        return false
      }
    }
    return true
  }

  private attachResult(
    replayThroughSeq: number,
    pending: ProviderRelayRecord[],
    initializeResultSent: boolean
  ): ProviderRelayAttachResult {
    return {
      replayThroughSeq,
      pending: pending.map((record) => record.seq),
      maxClientRequestId: this.pending.maxClientRequestId,
      initializeResultSent,
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
    const { stdin } = this.options.managed.child
    // An agent that stops reading must not grow the daemon's buffer without bound; the client retries.
    if (stdin.writableLength > MAX_QUEUED_INPUT_BYTES) {
      throw new Error('Relay input is full')
    }
    const answered = this.pending.observeClientData(data)
    // A request stays owed until its answer has reached the agent; a failed write keeps it.
    stdin.write(data, (error) => {
      if (!error && answered.length > 0) {
        this.pending.releaseAnswered(answered)
        this.updateReading()
      }
    })
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
    await Promise.all([
      this.spool.dispose(),
      this.lines.dispose().then(() => unlink(`${this.options.spoolPath}.line`).catch(() => {}))
    ])
  }

  /** Output was lost, so the agent is ended with the reason rather than left to a chat that waits forever. */
  private fail(reason: ProviderRelayFailure): void {
    this.failure ??= reason
    // The agent may have exited already; its exit must still say why output stopped.
    if (this.exitStatus && !this.exitStatus.error) {
      this.exitStatus = { ...this.exitStatus, error: reason }
    }
    this.options.log?.('relay-output-lost', { relayId: this.relayId, reason })
    void this.close().catch(() => {})
  }

  private stdoutDone(): void {
    this.stdoutEnded = true
    this.announceExitIfDone()
    // A trailing line flushed after exit may have reopened the spool.
    if (!this.live && !this.attachment) {
      this.spool.closeHandle()
    }
    // Exit usually lands first; the ended relay is only settled once its output has ended too.
    this.options.onSettled()
  }

  private appendLine(line: string, bytes: number): void {
    // Observe before append so a reattaching client sees the request in the pending table.
    const seq = this.spool.nextSeq
    if (this.live) {
      this.pending.observeAgentLine({ seq, line })
    }
    this.updateReading()
    this.spool.append(line, bytes)
  }

  /** Stdout pauses while the spool is at its cap or the agent is owed too many answers. */
  private updateReading(): void {
    // An exited agent answers nothing, so only the spool may still hold its output back.
    const paused = this.spoolPaused || this.readerBusy || (this.live && this.pending.full)
    if (paused !== this.readingPaused) {
      this.readingPaused = paused
      const { stdout } = this.options.managed.child
      if (paused) {
        stdout.pause()
      } else {
        stdout.resume()
      }
    }
  }

  private release(): void {
    this.attachment?.release()
    this.attachment = null
  }

  private deliver(record: ProviderRelayRecord): void {
    this.attachment?.sendLine('relayData', record)
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
    const sent = this.attachment?.send({
      type: 'event',
      event: 'relayExit',
      sessionId: this.relayId,
      payload: this.exitStatus
    })
    this.exitDelivered ||= sent === true
  }
}
