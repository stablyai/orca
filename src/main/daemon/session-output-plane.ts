import { resolveProcessExitCause, type TerminalExitCause } from '../../shared/terminal-exit-cause'
import { HeadlessEmulator } from './headless-emulator'
import { StartupDeviceAttributesQueryFilter } from './startup-device-attributes-responder'
import { normalizePtySize } from './daemon-pty-size'
import type { PtyIngressEmission } from '../../shared/pty-startup-ingress'
import type { PendingOutputRecord, TakePendingOutputResult, TerminalSnapshot } from './types'

// Why: bounds in-memory pending output when no client drains it; past the cap we drop records and flag
// overflow so the next take falls back to one full snapshot. UTF-16 units; worst-case wire is ~6x, under NDJSON_MAX_LINE_BYTES (16MB).
const PENDING_OUTPUT_MAX_BYTES = 2 * 1024 * 1024

export type AttachedClient = {
  token: symbol
  onData: (data: string, rawLength?: number, transformed?: boolean, seq?: number) => void
  onExit: (code: number, incarnationId: string, cause?: TerminalExitCause) => void
}

export type SessionOutputPlaneOptions = {
  cols: number
  rows: number
  scrollback?: number | undefined
  wslDistro?: string | undefined
  historySeedChunks?: readonly string[] | undefined
}

/** Everything downstream of the PTY: the scrollback emulator, the pending-output record buffer that
 *  feeds reattach/cold-restore, and fan-out to attached clients. */
export class SessionOutputPlane {
  readonly historySeeded: boolean | undefined
  private readonly emulator: HeadlessEmulator
  private attachedClients: AttachedClient[] = []
  private pendingOutputRecords: PendingOutputRecord[] = []
  private pendingOutputBytes = 0
  private pendingOutputOverflowed = false
  private pendingOutputSeq = 0
  private _outputSequence = 0
  private deviceAttributesQueryFilter: StartupDeviceAttributesQueryFilter | null = null
  private disposed = false

  constructor(opts: SessionOutputPlaneOptions) {
    const size = normalizePtySize(opts.cols, opts.rows)
    this.emulator = new HeadlessEmulator({
      cols: size.cols,
      rows: size.rows,
      scrollback: opts.scrollback,
      wslDistro: opts.wslDistro
      // No onData: the daemon emulator must never reply to query sequences — the renderer's xterm is
      // the authoritative responder and a daemon reply would race ahead and clobber it. See HeadlessEmulator.
      // The one exception is DA1 while the shell-ready barrier holds (below): the renderer's reply
      // would be queued behind the marker it is needed to produce, so it cannot be authoritative there.
    })
    // Why: seed recovery must precede listener registration; shells can emit their prompt synchronously once onData subscribes.
    // Why the every() short-circuit is safe: writeSync only fails emulator-wide (disposed / no sync write API), so later
    // chunks could not land either — and writing them past a dropped chunk would seed a torn stream.
    this.historySeeded =
      opts.historySeedChunks === undefined
        ? undefined
        : opts.historySeedChunks.every((chunk) => this.emulator.writeSync(chunk))
  }

  get responderParser(): HeadlessEmulator['responderParser'] {
    return this.emulator.responderParser
  }

  get hasAttachedClients(): boolean {
    return this.attachedClients.length > 0
  }

  attachClient(client: Omit<AttachedClient, 'token'>): symbol {
    const token = Symbol('attach')
    this.attachedClients.push({ token, ...client })
    return token
  }

  detachClient(token: symbol): void {
    const idx = this.attachedClients.findIndex((c) => c.token === token)
    if (idx !== -1) {
      this.attachedClients.splice(idx, 1)
    }
  }

  /** Drops every client WITHOUT touching producer flow control; the caller owns that ordering. */
  clearClients(): void {
    this.attachedClients = []
  }

  snapshotClients(): AttachedClient[] {
    return this.attachedClients.slice()
  }

  broadcastExit(code: number, incarnationId: string, cause?: TerminalExitCause): void {
    // Why the fallback here: a handle that predates exit causes still reports a
    // code, and every client deserves the same shape.
    const resolved = cause ?? resolveProcessExitCause({ exitCode: code })
    for (const client of this.attachedClients) {
      client.onExit(code, incarnationId, resolved)
    }
  }

  resize(cols: number, rows: number): void {
    this.emulator.resize(cols, rows)
    // Why: the record stream must mirror the emulator's apply order, or cold-restore replay reflows at the wrong point.
    this.record({ kind: 'resize', cols, rows })
  }

  clearScrollback(): void {
    this.emulator.clearScrollback()
    this.record({ kind: 'clear' })
  }

  isCursorOnEmptyPromptLine(): boolean {
    return this.emulator.isCursorOnEmptyPromptLine()
  }

  getCwd(): string | null {
    return this.emulator.getCwd()
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    if (this.disposed) {
      return null
    }
    return { ...this.emulator.getSnapshot(opts), outputSequence: this._outputSequence }
  }

  getPartialEscapeTailAnsi(): string {
    if (this.disposed) {
      return ''
    }
    return this.emulator.partialEscapeTailAnsi
  }

  // Why: returns the size the PTY actually applied (emulator dims) so the renderer can detect a
  // resize dropped here (exited/disposed/invalid) instead of trusting its last-requested size.
  getAppliedSize(): { cols: number; rows: number } | null {
    if (this.disposed) {
      return null
    }
    return this.emulator.getAppliedSize()
  }

  /** Holds back DA1 replies the child emits while the shell-ready barrier owns query authority. */
  installDeviceAttributesFilter(): void {
    this.deviceAttributesQueryFilter = new StartupDeviceAttributesQueryFilter()
  }

  /** Hands DA1 back to the renderer once the barrier is done, however it ended. */
  releaseDeviceAttributesFilter(): void {
    const pending = this.deviceAttributesQueryFilter?.release() ?? ''
    this.deviceAttributesQueryFilter = null
    if (pending.length === 0) {
      return
    }
    this.record({ kind: 'output', data: pending })
    for (const client of this.attachedClients) {
      client.onData(pending, 0, true, this._outputSequence)
    }
  }

  emit(emission: PtyIngressEmission): void {
    let { data } = emission
    const rawLength = emission.rawEndSeq - emission.rawStartSeq
    // Why: absolute raw count (daemon stream thinning can drop bytes) lets a snapshot cover the gaps while the renderer dedups the tail.
    this._outputSequence += rawLength
    if (data.length > 0) {
      this.emulator.write(data)
      data = this.deviceAttributesQueryFilter?.accept(data) ?? data
    }
    if (data.length > 0) {
      this.record({ kind: 'output', data })
    }

    // Broadcast to attached clients
    for (const client of this.attachedClients) {
      if (emission.transformed || rawLength !== data.length) {
        client.onData(data, rawLength, true, this._outputSequence)
      } else {
        client.onData(data)
      }
    }
  }

  record(record: PendingOutputRecord): void {
    if (this.pendingOutputOverflowed) {
      return
    }
    const bytes = record.kind === 'output' ? record.data.length : 8
    if (this.pendingOutputBytes + bytes > PENDING_OUTPUT_MAX_BYTES) {
      this.pendingOutputRecords = []
      this.pendingOutputBytes = 0
      this.pendingOutputOverflowed = true
      return
    }
    // Why: coalesce the thousands of tiny TUI chunks per tick to keep take RPC/log frames compact; 64KB cap bounds append cost.
    const last = this.pendingOutputRecords.at(-1)
    if (record.kind === 'output' && last?.kind === 'output' && last.data.length < 64 * 1024) {
      last.data += record.data
    } else {
      this.pendingOutputRecords.push(record)
    }
    this.pendingOutputBytes += bytes
  }

  /** Drains records accumulated since the last take. `takeSnapshot` runs after the drain so no PTY
   *  data lands between the two (which would replay twice on cold restore). */
  takePendingOutput(
    includeSnapshot: boolean,
    releasedHeldBytes: string,
    takeSnapshot: () => TerminalSnapshot | null
  ): TakePendingOutputResult {
    const records = this.pendingOutputRecords
    const overflowed = this.pendingOutputOverflowed
    this.pendingOutputRecords = []
    this.pendingOutputBytes = 0
    this.pendingOutputOverflowed = false
    // Empty incremental takes are not persisted; advancing them would create a false reattach gap.
    if (includeSnapshot || records.length > 0 || overflowed) {
      this.pendingOutputSeq += 1
    }
    return {
      records: includeSnapshot
        ? releasedHeldBytes
          ? [{ kind: 'output', data: releasedHeldBytes }]
          : []
        : records,
      ...(includeSnapshot ? { drainedRecords: records } : {}),
      seq: this.pendingOutputSeq,
      overflowed,
      snapshot: includeSnapshot ? takeSnapshot() : null
    }
  }

  /** Marks the plane's read surface dead (mirrors Session's `_disposed`) without freeing the emulator,
   *  which outlives fd teardown so an already-exited session can still be snapshotted. */
  markDisposed(): void {
    this.disposed = true
  }

  disposeEmulator(): void {
    this.emulator.dispose()
  }
}
