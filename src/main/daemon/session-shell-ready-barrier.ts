import { shellReadyMarkerComesFromLineEditor } from '../../shared/shell-ready-marker-timing'
import {
  installDeviceAttributesResponder,
  STARTUP_DA1_RESPONSE
} from './startup-device-attributes-responder'
import { PostReadyFlushGate } from './post-ready-flush-gate'
import {
  createShellStartupOutputScanState,
  drainShellStartupOutputScanState,
  scanShellStartupOutput,
  type ShellStartupOutputScanState
} from '../shell-startup-output-scanner'
import type { HeadlessEmulator } from './headless-emulator'
import type { SubprocessHandle } from './session-subprocess-handle'
import { basename } from 'node:path'
import type { ShellReadyState } from './types'

const SHELL_READY_TIMEOUT_MS = 15_000

export type SessionShellReadyBarrierDeps = {
  sessionId: string
  subprocess: SubprocessHandle
  responderParser: HeadlessEmulator['responderParser']
  shellReadySupported: boolean
  shellReadyTimeoutMs: number | undefined
  installDeviceAttributesFilter(): void
  releaseDeviceAttributesFilter(): void
  acceptStartupIngress(data: string): void
  /** Reports a readiness outcome worth diagnosing. Why injected rather than
   *  console: the daemon runs detached with stdio 'ignore', so console output
   *  goes nowhere -- the only durable sink is the daemon's NDJSON file log. */
  reportReadinessEvent?(event: string, details: Record<string, unknown>): void
}

/** The startup gate every byte of PTY output passes through: it strips the shell-ready marker, holds
 *  startup commands until the shell can accept them, and owns DA1 authority for as long as the gate is closed. */
export class SessionShellReadyBarrier {
  private _state: ShellReadyState
  private scanState: ShellStartupOutputScanState | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private releaseDeviceAttributesResponder: (() => void) | null = null
  private preReadyStdinQueue: string[] = []
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

  /** True while startup commands must be queued: pre-marker, or inside the post-ready flush-gate window. */
  get isGatingWrites(): boolean {
    return this._state === 'pending' || this.postReadyFlushGate.isPending
  }

  /** Queues `data` when the gate is closed; false means the caller must write it through. */
  tryEnqueue(data: string): boolean {
    if (!this.isGatingWrites) {
      return false
    }
    this.preReadyStdinQueue.push(data)
    return true
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
    // Why: scanning strips marker bytes before fan-out; if readiness never completes, release any held prefix before timeout/exit discards it.
    this.deps.acceptStartupIngress(heldBytes)
    return heldBytes
  }

  /** Hands DA1 back to the renderer once the barrier is done, however it ended. */
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

  /** Drops queued stdin and the flush gate; teardown does this, and dispose repeats it defensively. */
  clearPendingWrites(): void {
    this.preReadyStdinQueue = []
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

  /** Why the shell basename and not its path: the path can carry a home dir, and
   *  the basename is all a diagnosis needs. The session id is already logged by
   *  the daemon's session lifecycle events, so it is only correlation here. */
  private reportReadiness(event: string, details: Record<string, unknown>): void {
    const shellPath = this.deps.subprocess.shellPath
    try {
      this.deps.reportReadinessEvent?.(event, {
        sessionId: this.deps.sessionId,
        shell: shellPath ? basename(shellPath) : 'unknown',
        ...details
      })
    } catch {
      // Why swallow: this runs before the state transition that releases held
      // PTY bytes and flushes queued stdin, and the ready timer is already
      // cleared. A throwing sink must never strand the barrier in `pending`
      // with nothing left to wake it -- diagnostics cannot break the terminal.
    }
  }

  private onShellReadyTimeout(): void {
    this.readyTimer = null
    if (this._state !== 'pending') {
      return
    }
    // Why report: this path costs every startup command the full timeout, and it
    // used to fail silently -- a wrapper that never emits the marker looks
    // identical to a slow shell. Name the shell so the next report can be
    // diagnosed from the log alone.
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
    for (const data of queued) {
      this.deps.subprocess.write(data)
    }
  }
}
