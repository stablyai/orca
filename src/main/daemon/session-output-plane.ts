import { resolveProcessExitCause, type TerminalExitCause } from '../../shared/terminal-exit-cause'
import { HeadlessEmulator } from './headless-emulator'
import { StartupDeviceAttributesQueryFilter } from './startup-device-attributes-responder'
import { normalizePtySize } from './daemon-pty-size'
import type { PtyIngressEmission } from '../../shared/pty-startup-ingress'
import type { PendingOutputRecord, TakePendingOutputResult, TerminalSnapshot } from './types'
import type { TerminalOwner } from '../../shared/terminal-owner'
import type { SubprocessHandle } from './session-subprocess-handle'
import { nudgePowerShellPromptRepaint } from './session-powershell-prompt-repaint'

// Count UTF-16 units; even JSON escape expansion stays below the NDJSON line cap.
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
  /** Read ownership after the barrier scans bytes, keeping snapshot metadata aligned with the emulator. */
  getTerminalOwner?: (() => TerminalOwner | undefined) | undefined
}

export class SessionOutputPlane {
  readonly historySeeded: boolean | undefined
  private readonly emulator: HeadlessEmulator
  private readonly readTerminalOwner: (() => TerminalOwner | undefined) | undefined
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
      // Keep the emulator silent; the shell-ready barrier separately owns startup DA1 replies.
    })
    // Seed before subscribing to synchronous shell output; stop at any failed chunk to avoid a torn stream.
    this.historySeeded =
      opts.historySeedChunks === undefined
        ? undefined
        : opts.historySeedChunks.every((chunk) => this.emulator.writeSync(chunk))
    this.readTerminalOwner = opts.getTerminalOwner
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

  /** The caller must release producer flow control separately. */
  clearClients(): void {
    this.attachedClients = []
  }

  snapshotClients(): AttachedClient[] {
    return this.attachedClients.slice()
  }

  broadcastExit(code: number, incarnationId: string, cause?: TerminalExitCause): void {
    // Older subprocess handles may report an exit code without a cause.
    const resolved = cause ?? resolveProcessExitCause({ exitCode: code })
    for (const client of this.attachedClients) {
      client.onExit(code, incarnationId, resolved)
    }
  }

  resize(cols: number, rows: number): void {
    this.emulator.resize(cols, rows)
    // Preserve emulator apply order so recovery reflows at the same stream position.
    this.record({ kind: 'resize', cols, rows })
  }

  clearScrollback(subprocess: SubprocessHandle, isGatingWrites: boolean): void {
    if (this.disposed) {
      return
    }
    this.emulator.clearScrollback()
    this.record({ kind: 'clear' })
    subprocess.clear?.()
    nudgePowerShellPromptRepaint({
      subprocess,
      isGatingWrites,
      isCursorOnEmptyPromptLine: () => this.isCursorOnEmptyPromptLine()
    })
  }

  /** Ground emulator and recovery records only; attached renderers perform their own reset. */
  applyInputModeGround(ground: string): void {
    if (this.disposed) {
      return
    }
    this.emulator.write(ground)
    this.record({ kind: 'output', data: ground })
  }

  isCursorOnEmptyPromptLine(): boolean {
    return this.emulator.isCursorOnEmptyPromptLine()
  }

  getCwd(): string | null {
    return this.emulator.getCwd()
  }

  getTerminalOwner(): TerminalOwner | undefined {
    return this.readTerminalOwner?.()
  }

  /** Fence prior async writes before taking a snapshot of the model. */
  flushParsedWrites(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    return this.emulator.write('')
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    if (this.disposed) {
      return null
    }
    const terminalOwner = this.readTerminalOwner?.()
    return {
      ...this.emulator.getSnapshot(opts),
      ...(terminalOwner ? { terminalOwner } : {}),
      outputSequence: this._outputSequence
    }
  }

  getPartialEscapeTailAnsi(): string {
    if (this.disposed) {
      return ''
    }
    return this.emulator.partialEscapeTailAnsi
  }

  // Report applied dimensions so the renderer can detect dropped resizes.
  getAppliedSize(): { cols: number; rows: number } | null {
    if (this.disposed) {
      return null
    }
    return this.emulator.getAppliedSize()
  }

  /** Filter startup DA1 queries already answered by the shell-ready barrier. */
  installDeviceAttributesFilter(): void {
    this.deviceAttributesQueryFilter = new StartupDeviceAttributesQueryFilter()
  }

  /** Return query authority and any held partial query to the renderer. */
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
    // Count raw input even when thinning drops bytes so snapshots and renderer tail deduplication align.
    this._outputSequence += rawLength
    if (data.length > 0) {
      this.emulator.write(data)
      data = this.deviceAttributesQueryFilter?.accept(data) ?? data
    }
    if (data.length > 0) {
      this.record({ kind: 'output', data })
    }

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
    // Coalesce small adjacent output records to reduce RPC and log-frame overhead.
    const last = this.pendingOutputRecords.at(-1)
    if (record.kind === 'output' && last?.kind === 'output' && last.data.length < 64 * 1024) {
      last.data += record.data
    } else {
      this.pendingOutputRecords.push(record)
    }
    this.pendingOutputBytes += bytes
  }

  /** Drain and snapshot in one synchronous turn so no PTY bytes can be replayed twice. */
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

  /** Invalidate the read surface without freeing the emulator yet. */
  markDisposed(): void {
    this.disposed = true
  }

  disposeEmulator(): void {
    this.emulator.dispose()
  }
}
