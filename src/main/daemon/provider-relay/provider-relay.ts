import type { ProviderRelayOptions as RelayOptions } from './provider-relay-options'
import type {
  ProviderRelayAttachResult,
  ProviderRelayDetachPolicy,
  ProviderRelayExit,
  ProviderRelayFailure,
  ProviderRelayInfo,
  ProviderRelayRecord
} from '../protocol/daemon-provider-relay-protocol'
import { ProviderRelayPendingRequests } from './provider-relay-pending-requests'
import { ProviderRelaySpool } from './provider-relay-spool'
import { ProviderRelayLineReader } from './provider-relay-line-reader'
import { ProviderRelayAttachment, type ProviderRelayStream } from './provider-relay-attachment'
import { ProviderRelayInput } from './provider-relay-input'
import { ProviderRelayIdleStop } from './provider-relay-idle-stop'

const RELAY_TAKEN_OVER = 'Relay attach superseded by a detach or another attach'

/** One daemon-owned agent: its stdout spool, unanswered requests, and the one client attached. */
export class ProviderRelay {
  readonly relayId: string
  readonly chatKey: string
  readonly spawnedAtMs = Date.now()
  readonly pending = new ProviderRelayPendingRequests(() => this.spool.ackedSeq)
  private readonly spool: ProviderRelaySpool
  private attachment: ProviderRelayAttachment | null = null
  private readonly lines: ProviderRelayLineReader
  private readerBusy = false
  private exitStatus: ProviderRelayExit | null = null
  private idleStopped = false
  /** The client's own acks that gave up an open kept span (the daemon's ask at its file cap). */
  private cutThrough = 0
  private stdoutEnded = false
  private exitAnnounced = false
  private spoolPaused = false
  private readingPaused = false
  private failure: ProviderRelayFailure | null = null
  private readonly input: ProviderRelayInput
  /** The relay is kept until a client was actually sent its exit, so no outcome goes unseen. */
  private exitDelivered = false
  /** The attachment the exit last went to, so one client never gets it twice. */
  private exitSentTo: ProviderRelayAttachment | null = null
  private readonly idleStop: ProviderRelayIdleStop
  /** What a paused relay asks its client to ack: only while streaming live, never mid-replay. */
  private readonly askedSeq = () => (this.spool.streaming ? this.spool.nextSeq - 1 : null)

  constructor(private readonly options: RelayOptions) {
    this.relayId = options.relayId
    this.chatKey = options.chatKey
    this.idleStop = ProviderRelayIdleStop.forRelay(this, options, () => this.spool.unacked())
    const stdout = options.managed.child.stdout
    this.input = new ProviderRelayInput(options.managed.child.stdin)
    this.spool = new ProviderRelaySpool({
      path: options.spoolPath,
      deliver: (record) => this.deliver(record),
      onPressureChanged: (paused) => {
        this.spoolPaused = paused
        this.attachment?.whilePaused(paused, this.askedSeq)
        this.updateReading()
      },
      drained: () => this.attachment?.drained() ?? Promise.resolve(),
      onFileLost: () => this.fail('spool-unreadable'),
      onAckWanted: (seq) => this.attachment?.askForAck(seq),
      // Deferred, so the host's cleanup never runs inside a spool method.
      onDrained: () => queueMicrotask(() => options.onSettled())
    })
    this.lines = new ProviderRelayLineReader({
      spillPath: `${options.spoolPath}.line`,
      onLine: (line, bytes) => void (this.idleStop.quiet(line) || this.appendLine(line, bytes)),
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
    let ending = false
    stdout.once('end', () => {
      if (!ending) {
        ending = true
        void this.lines.end().then(() => this.stdoutDone())
      }
    })
    // A read error loses output: no fragment is published, and the agent is ended with the reason.
    stdout.on('error', () => {
      if (!ending) {
        ending = true
        this.fail('line-unreadable')
        void this.lines.dispose().then(() => this.stdoutDone())
      }
    })
    options.managed.child.stdin.on('error', () => {})
    options.managed.onExit((exit) => {
      this.exitStatus = {
        code: exit.code,
        signal: exit.signal,
        ...(this.failure ? { error: this.failure } : {}),
        ...(this.idleStopped ? { idleStopped: true as const } : {})
      }
      this.pending.clear()
      this.idleStop.disarm()
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

  /**
   * Ended, its exit sent to a client and fully acked: nothing left that a client could still need.
   * A client mid-attach hasn't had the exit yet, so a release during its replay can't remove it.
   */
  get finished(): boolean {
    return (
      this.exitDelivered &&
      this.stdoutEnded &&
      this.spool.drained &&
      (this.attachment === null || this.exitSentTo === this.attachment)
    )
  }

  get idleStopPolicy(): Pick<ProviderRelayIdleStop, 'configure'> {
    return this.idleStop
  }

  async attach(
    clientId: string,
    stream: ProviderRelayStream,
    fromSeq: number
  ): Promise<ProviderRelayAttachResult> {
    // Clamped before any wait: output arriving during the attach must stay above the cursor.
    const cursor = Math.min(fromSeq, this.spool.nextSeq - 1)
    this.idleStop.disarm()
    // Read before the replay: lines released later through this client's own acks reached it.
    const truncatedThrough = Math.max(this.spool.truncatedThrough, this.cutThrough)
    this.options.log?.('relay-attached', { relayId: this.relayId, cursor, truncatedThrough })
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
    const { initializeResult } = this.pending
    const { records: kept, lines: keptLines } = this.pending.kept.snapshot()
    const pending = this.pending.records()
    const sent = await attachment.sendPreamble(initializeResult, kept, pending)
    // A detach or takeover during the preamble owns the spool now; this attach must not touch it.
    if (!sent || this.attachment !== attachment) {
      throw new Error(RELAY_TAKEN_OVER)
    }
    let replayThroughSeq: number
    try {
      replayThroughSeq = await this.spool.attach(cursor)
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
    attachment.whilePaused(this.spoolPaused, this.askedSeq)
    if (this.exitAnnounced) {
      this.sendExit()
    }
    return {
      ...this.pending.kept.attachDetails(Math.max(cursor, this.spool.ackedSeq), keptLines),
      replayThroughSeq,
      pending: pending.map((record) => record.seq),
      maxClientRequestId: this.pending.maxClientRequestId,
      initializeResultSent: initializeResult !== null,
      stderrTail: this.options.managed.stderrTail(),
      exit: this.exitStatus,
      // Lines the client already had before its cursor were never missing from its replay.
      // A cut at the cursor counts too: the kept lines it gave up were the ones a replay needed.
      ...(truncatedThrough > 0 && truncatedThrough >= cursor ? { truncatedThrough } : {}),
      ...this.idleStop.carriedWork()
    }
  }

  detach(clientId?: string, policy?: ProviderRelayDetachPolicy | null): Promise<void> {
    if (clientId !== undefined && this.attachedClientId !== clientId) {
      return Promise.resolve()
    }
    this.release()
    // A dropped stream (app crash) arms the policy the app gave at spawn or attach.
    if (this.live) {
      this.idleStop.arm(policy ?? null)
    }
    const detached = this.spool.detach()
    if (!this.live) {
      this.spool.closeHandle()
    }
    this.options.onDetached()
    return detached
  }

  write(chunk: string): void {
    const data = this.input.take(chunk)
    const answered = this.pending.observeClientData(data)
    // A request stays owed until its answer has reached the agent; a failed write keeps it.
    this.input.write(data, (error) => {
      if (!error && answered.length > 0) {
        this.pending.releaseAnswered(answered)
        this.updateReading()
      }
    })
  }

  /** How far the spool released; past `keepFrom` once its file cap let a held replay go. */
  ack(seq: number, keepFrom?: number, { cut = false, held = false } = {}): number {
    // Kept from `keepFrom` on, the cut is before it: a replay from there starts inside the item.
    const cutAt = keepFrom === undefined ? seq : keepFrom - 1
    this.cutThrough = cut ? Math.max(this.cutThrough, cutAt) : this.cutThrough
    return this.spool.ack(seq, keepFrom, held)
  }

  stopIdle(): Promise<unknown> {
    this.idleStopped = true
    return this.close()
  }

  close(grace?: 'brief'): Promise<unknown> {
    this.input.flush()
    return this.options.managed.close(undefined, grace === 'brief' ? { grace } : undefined)
  }

  info(): ProviderRelayInfo {
    return {
      relayId: this.relayId,
      chatKey: this.chatKey,
      agent: this.options.agent ?? null,
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
    this.idleStop.disarm()
    this.release()
    if (this.live) {
      // stdin end starts provider-exec's own close ladder; owner death would start the same one.
      void this.close().catch(() => {})
    }
    await Promise.all([this.spool.dispose(), this.lines.dispose()])
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
      this.idleStop.observeAgentLine(line)
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
      void (paused ? stdout.pause() : stdout.resume())
    }
  }

  private release(): void {
    this.attachment?.release()
    this.attachment = null
  }

  private deliver(record: ProviderRelayRecord): void {
    this.attachment?.sendLine('relayData', this.pending.answered.replayed(record))
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
    if (this.attachment === null || this.exitSentTo === this.attachment) {
      return
    }
    this.exitSentTo = this.attachment
    const sent = this.attachment.send({
      type: 'event',
      event: 'relayExit',
      sessionId: this.relayId,
      payload: { ...this.exitStatus, stderrTail: this.options.managed.stderrTail() }
    })
    this.exitDelivered ||= sent === true
  }
}
