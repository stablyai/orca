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
import {
  createShellPromptReadinessProbe,
  type ShellPromptReadinessProbe
} from '../shell-prompt-readiness-probe'
import type { HeadlessEmulator } from './headless-emulator'
import type { SubprocessHandle } from './session-subprocess-handle'
import { basename } from 'node:path'
import type { ShellReadyState } from './types'

const SHELL_READY_TIMEOUT_MS = 15_000
export const CODEX_SHELL_READY_TIMEOUT_MS = 300

export type SessionShellReadyBarrierDeps = {
  sessionId: string
  subprocess: SubprocessHandle
  responderParser: HeadlessEmulator['responderParser']
  shellReadySupported: boolean
  shellReadyTimeoutMs: number | undefined
  installDeviceAttributesFilter(): void
  releaseDeviceAttributesFilter(): void
  acceptStartupIngress(data: string): void
  /** Use an injected file-log sink because detached daemon stdio is ignored. */
  reportReadinessEvent?(event: string, details: Record<string, unknown>): void
}

/** Strip startup markers and gate stdin; hold DA1 authority until shell readiness resolves. */
export class SessionShellReadyBarrier {
  private _state: ShellReadyState
  private scanState: ShellStartupOutputScanState | null = null
  private shellStartupPid: number | null = null
  private promptReadinessProbe: ShellPromptReadinessProbe | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private releaseDeviceAttributesResponder: (() => void) | null = null
  private preReadyStdinQueue: string[] = []
  private readonly postReadyFlushGate: PostReadyFlushGate

  constructor(private readonly deps: SessionShellReadyBarrierDeps) {
    if (deps.shellReadySupported) {
      this._state = 'pending'
      this.scanState = createShellStartupOutputScanState()
      // Answer DA1 past queued stdin, or a shell waiting for that reply can never emit its ready marker.
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

  /** Keep queuing through the post-marker flush window to preserve input order. */
  get isGatingWrites(): boolean {
    return this._state === 'pending' || this.postReadyFlushGate.isPending
  }

  /** Start after startup ingress exists, because probe callbacks may emit immediately. */
  startPromptReadinessProbe(): void {
    if (this._state !== 'pending') {
      return
    }
    this.promptReadinessProbe = createShellPromptReadinessProbe({
      slavePath: this.deps.subprocess.slavePath,
      shellPath: this.deps.subprocess.shellPath,
      shellCwd: this.deps.subprocess.shellCwd,
      shellPathEnv: this.deps.subprocess.shellPathEnv,
      getShellPid: () => this.shellStartupPid,
      onPromptReady: () => this.onShellPromptReady()
    })
  }

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
      if (scanned.shellPid) {
        this.shellStartupPid = scanned.shellPid
      }
      if (scanned.ready) {
        this.transitionToReady(scanned.postMarkerBytesObserved)
        releaseStartupDeviceAttributes = true
      }
    } else {
      this.postReadyFlushGate.notifyData()
    }

    this.deps.acceptStartupIngress(data)
    if (this._state === 'pending' && data.length > 0) {
      this.promptReadinessProbe?.notifyOutput(data)
    }
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

  disposePromptReadinessProbe(): void {
    this.promptReadinessProbe?.dispose()
    this.promptReadinessProbe = null
  }

  clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }

  clearPendingWrites(): void {
    this.preReadyStdinQueue = []
    this.postReadyFlushGate.clear()
  }

  clearFlushGate(): void {
    this.postReadyFlushGate.clear()
  }

  dispose(): void {
    this.clearReadyTimer()
    this.disposePromptReadinessProbe()
    this.scanState = null
    this.clearPendingWrites()
  }

  private transitionToReady(postMarkerBytesObserved = false): void {
    this._state = 'ready'
    this.scanState = null
    this.disposePromptReadinessProbe()
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
    this.disposePromptReadinessProbe()
    this.releaseDeviceAttributes()
    this.releaseHeldBytes()
    this.flushPreReadyQueue()
  }

  private onShellPromptReady(): void {
    if (this._state !== 'pending') {
      return
    }
    this.reportReadiness('shell-ready-wrapper-replaced', {})
    this.releaseHeldBytes()
    this.transitionToReady(true)
    this.releaseDeviceAttributes()
  }

  private flushPreReadyQueue(): void {
    const queued = this.preReadyStdinQueue
    this.preReadyStdinQueue = []
    for (const data of queued) {
      this.deps.subprocess.write(data)
    }
  }
}
