import { shellReadyMarkerComesFromLineEditor } from '../../../shared/terminal/output/shell-ready-marker-timing'
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
// The wrapper claims right after its marker; a hook that execs a new shell first leaves the claim to the host.
const POST_READY_STARTUP_CLAIM_GRACE_MS = 3_000

export type SessionShellReadyBarrierDeps = {
  sessionId: string
  subprocess: SubprocessHandle
  responderParser: HeadlessEmulator['responderParser']
  shellReadySupported: boolean
  shellReadyTimeoutMs: number | undefined
  installDeviceAttributesFilter(): void
  releaseDeviceAttributesFilter(): void
  acceptStartupIngress(data: string): void
  startupCommandFallback?: StartupCommandFallback
  /** Use an injected file-log sink because detached daemon stdio is ignored. */
  reportReadinessEvent?(event: string, details: Record<string, unknown>): void
}

/** A wrapper-run startup command, typed after timeout only if the wrapper has not claimed it. */
export type StartupCommandFallback = {
  claim(): Promise<boolean>
  build(): string
}

/** Strip startup markers and hold startup commands until shell readiness resolves. */
export class SessionShellReadyBarrier {
  private _state: ShellReadyState
  private scanState: ShellStartupOutputScanState | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private releaseDeviceAttributesResponder: (() => void) | null = null
  private preReadyStdinQueue: string[] = []
  private startupCommandFallback: StartupCommandFallback | null = null
  private writesClosed = false
  private startupCommandFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private readonly postReadyFlushGate: PostReadyFlushGate

  constructor(private readonly deps: SessionShellReadyBarrierDeps) {
    if (deps.shellReadySupported) {
      this._state = 'pending'
      this.scanState = createShellStartupOutputScanState()
      this.startupCommandFallback = deps.startupCommandFallback ?? null
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
    this.writesClosed = true
    this.preReadyStdinQueue = []
    if (this.startupCommandFallbackTimer) {
      clearTimeout(this.startupCommandFallbackTimer)
      this.startupCommandFallbackTimer = null
    }
    // Claiming also removes the claim file once no shell can take it.
    void this.startupCommandFallback?.claim()
    this.startupCommandFallback = null
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
    if (this.startupCommandFallback) {
      this.startupCommandFallbackTimer = setTimeout(() => {
        this.startupCommandFallbackTimer = null
        this.runStartupCommandFallback()
      }, POST_READY_STARTUP_CLAIM_GRACE_MS)
    }
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
    this.runStartupCommandFallback()
  }

  // Types the launch only when the claim proves the shell wrapper never ran it.
  private runStartupCommandFallback(): void {
    const fallback = this.startupCommandFallback
    this.startupCommandFallback = null
    void fallback?.claim().then((won) => {
      if (won && !this.writesClosed) {
        this.deps.subprocess.write(fallback.build())
      }
    })
  }

  private flushPreReadyQueue(): void {
    const queued = this.preReadyStdinQueue
    this.preReadyStdinQueue = []
    for (const data of queued) {
      this.deps.subprocess.write(data)
    }
  }
}
