import { shellReadyMarkerComesFromLineEditor } from '../../../shared/terminal/output/shell-ready-marker-timing'
import { extractOnlyTerminalQueryReplies } from '../../../shared/terminal/protocol/queries/terminal-query-reply'
import {
  installDeviceAttributesResponder,
  STARTUP_DA1_RESPONSE
} from '../emulation/startup-device-attributes-responder'
import { PostReadyFlushGate } from '../shell-readiness/post-ready-flush-gate'
import {
  createShellStartupOutputScanState,
  drainShellStartupOutputScanState,
  scanShellStartupOutput,
  type ShellStartupOutputScanState
} from '../../pty/shell-startup/shell-startup-output-scanner'
import type { HeadlessEmulator } from '../emulation/headless-emulator'
import type { SubprocessHandle } from './session-subprocess-handle'
import { basename } from 'node:path'
import type { ShellReadyState } from '../protocol/daemon-rpc-contract'

const SHELL_READY_TIMEOUT_MS = 15_000
// Ctrl+U kills typed text left of the cursor in zsh, bash and fish, the only shells this barrier holds commands for.
// The leading space keeps the cursor off column 0, where bash rings the bell on ^U (e.g. on an already empty line).
const KILL_TYPED_LINE = ' \x15'

/** True when `data` leaves unsubmitted typed text on the current line after any line-submit/clear control. */
function hasTrailingTypedLine(data: string): boolean {
  let tailStart = 0
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i)
    // CR, LF, Ctrl-C, Ctrl-D, Ctrl-U submit or clear the active line (e.g. an answered rc-file read prompt).
    if (code === 0x0d || code === 0x0a || code === 0x03 || code === 0x04 || code === 0x15) {
      tailStart = i + 1
    }
  }
  if (tailStart === 0) {
    return true
  }
  const tail = data.slice(tailStart)
  return tail.length > 0 && !extractOnlyTerminalQueryReplies(tail)
}

export type SessionShellReadyBarrierDeps = {
  sessionId: string
  subprocess: SubprocessHandle
  responderParser: HeadlessEmulator['responderParser']
  shellReadySupported: boolean
  shellReadyTimeoutMs: number | undefined
  installDeviceAttributesFilter(): void
  releaseDeviceAttributesFilter(): void
  acceptStartupIngress(data: string): void
  /** A held startup command reached the shell: input the pane's idle proof must see. */
  noteQueuedInputWritten?(): void
  /** Use an injected file-log sink because detached daemon stdio is ignored. */
  reportReadinessEvent?(event: string, details: Record<string, unknown>): void
}

/** Strip startup markers and hold startup commands until shell readiness resolves. */
export class SessionShellReadyBarrier {
  private _state: ShellReadyState
  private scanState: ShellStartupOutputScanState | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private releaseDeviceAttributesResponder: (() => void) | null = null
  private preReadyStdinQueue: string[] = []
  private typedAhead = false
  private readonly postReadyFlushGate: PostReadyFlushGate

  constructor(private readonly deps: SessionShellReadyBarrierDeps) {
    if (deps.shellReadySupported) {
      this._state = 'pending'
      this.scanState = createShellStartupOutputScanState()
      // Answer startup DA1 locally so shells waiting for it can reach their ready marker.
      this.releaseDeviceAttributesResponder = installDeviceAttributesResponder({
        parser: deps.responderParser,
        response: STARTUP_DA1_RESPONSE,
        reply: (data) => deps.subprocess.write(data)
      })
      deps.installDeviceAttributesFilter()
      this.readyTimer = setTimeout(() => {
        this.onShellReadyTimeout()
      }, deps.shellReadyTimeoutMs ?? SHELL_READY_TIMEOUT_MS)
    } else {
      this._state = 'unsupported'
    }

    this.postReadyFlushGate = new PostReadyFlushGate(
      () => this.flushPreReadyQueue(),
      shellReadyMarkerComesFromLineEditor(deps.subprocess.shellPath ?? '')
    )
  }

  get state(): ShellReadyState {
    return this._state
  }

  /** Keep startup commands queued through the post-marker flush window. */
  get isGatingWrites(): boolean {
    return this._state === 'pending' || this.postReadyFlushGate.isPending
  }

  /** A startup command still waits for the shell; it may start an agent with no other event. */
  get hasQueuedInput(): boolean {
    return this.preReadyStdinQueue.length > 0
  }

  /** Queues `data` when the gate is closed; false means the caller must write it through. */
  tryEnqueue(data: string): boolean {
    if (!this.isGatingWrites) {
      return false
    }
    this.preReadyStdinQueue.push(data)
    return true
  }

  /** Track unsubmitted input typed while a startup command is held, so the flush can clear the line first. */
  observeTypedInput(data: string): void {
    if (this.preReadyStdinQueue.length === 0 || !data || extractOnlyTerminalQueryReplies(data)) {
      return
    }
    this.typedAhead = hasTrailingTypedLine(data)
  }

  ingestSubprocessData(data: string): void {
    let releaseStartupDeviceAttributes = false
    if (this._state === 'pending' && this.scanState) {
      const scanned = scanShellStartupOutput(this.scanState, data)
      data = scanned.output
      if (scanned.ready) {
        this.transitionToReady(scanned.postMarkerBytesObserved)
        releaseStartupDeviceAttributes = true
      }
    } else {
      this.postReadyFlushGate.notifyData()
    }

    this.deps.acceptStartupIngress(data)
    if (releaseStartupDeviceAttributes) {
      this.releaseDeviceAttributes()
    }
  }

  releaseHeldBytes(): string {
    if (!this.scanState) {
      return ''
    }
    const heldBytes = drainShellStartupOutputScanState(this.scanState)
    this.scanState = null
    // Preserve an incomplete marker prefix when timeout or exit ends scanning.
    this.deps.acceptStartupIngress(heldBytes)
    return heldBytes
  }

  /** Release startup DA1 authority on every completion path. */
  releaseDeviceAttributes(): void {
    this.releaseDeviceAttributesResponder?.()
    this.releaseDeviceAttributesResponder = null
    this.deps.releaseDeviceAttributesFilter()
  }

  clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }

  clearPendingWrites(): void {
    this.preReadyStdinQueue = []
    this.typedAhead = false
    this.postReadyFlushGate.clear()
  }

  clearFlushGate(): void {
    this.postReadyFlushGate.clear()
  }

  dispose(): void {
    this.clearReadyTimer()
    this.scanState = null
    this.clearPendingWrites()
  }

  private transitionToReady(postMarkerBytesObserved = false): void {
    this._state = 'ready'
    this.scanState = null
    this.clearReadyTimer()
    if (this.preReadyStdinQueue.length === 0) {
      return
    }
    this.postReadyFlushGate.arm(postMarkerBytesObserved)
  }

  // Log only the shell basename to avoid disclosing home-directory paths.
  private reportReadiness(event: string, details: Record<string, unknown>): void {
    const shellPath = this.deps.subprocess.shellPath
    try {
      this.deps.reportReadinessEvent?.(event, {
        sessionId: this.deps.sessionId,
        shell: shellPath ? basename(shellPath) : 'unknown',
        ...details
      })
    } catch {
      // A throwing diagnostic sink must not strand the barrier after its ready timer is cleared.
    }
  }

  private onShellReadyTimeout(): void {
    this.readyTimer = null
    if (this._state !== 'pending') {
      return
    }
    this.reportReadiness('shell-ready-timeout', {
      timeoutMs: this.deps.shellReadyTimeoutMs ?? SHELL_READY_TIMEOUT_MS
    })
    this._state = 'timed_out'
    this.releaseDeviceAttributes()
    this.releaseHeldBytes()
    this.flushPreReadyQueue()
  }

  private flushPreReadyQueue(): void {
    const queued = this.preReadyStdinQueue
    this.preReadyStdinQueue = []
    // Only clear a partial prompt line when the shell reached its line editor; on timeout an rc-file reader may still own stdin.
    if (this._state === 'ready' && this.typedAhead) {
      this.deps.subprocess.write(KILL_TYPED_LINE)
    }
    this.typedAhead = false
    for (const data of queued) {
      this.deps.noteQueuedInputWritten?.()
      this.deps.subprocess.write(data)
    }
  }
}
