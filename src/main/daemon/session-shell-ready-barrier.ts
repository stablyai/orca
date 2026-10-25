import type { NativeSetupWrite } from './session-options'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import {
  appendNativeSetupCompletion,
  nativeSetupCompletionShell,
  type NativeSetupCompletionShell
} from '../runtime/orchestration/setup-completion-signal'
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
  readMatchingPromptShellExecutable,
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
  nativeSetupToken?: string
  shellReadySupported: boolean
  shellReadyTimeoutMs: number | undefined
  installDeviceAttributesFilter(): void
  releaseDeviceAttributesFilter(): void
  acceptStartupIngress(data: string, removed?: boolean): void
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
  private nativeSetupShell: NativeSetupCompletionShell | undefined
  private preReadyStdinQueue: {
    data: string
    startup?: { command: string; token: string; bracketedPasteSafe: boolean }
  }[] = []
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
      onPromptReady: (executable) => {
        this.nativeSetupShell = nativeSetupCompletionShell(executable)
        this.onShellPromptReady()
      }
    })
  }

  /** Queues `data` when the gate is closed; false means the caller must write it through. */
  tryEnqueue(data: string, setup?: NativeSetupWrite): boolean {
    if (setup) {
      this.writeStartupCommand(setup.command, setup.token, setup.bracketedPasteSafe)
      return true
    }
    if (!this.isGatingWrites) {
      return false
    }
    this.preReadyStdinQueue.push({ data })
    return true
  }

  writeStartupCommand(command: string, token: string, bracketedPasteSafe: boolean): void {
    const data = buildStartupCommandSubmission(command, { bracketedPasteSafe })
    if (this.isGatingWrites) {
      this.preReadyStdinQueue.push({ data, startup: { command, token, bracketedPasteSafe } })
    } else {
      const shell = nativeSetupCompletionShell(this.deps.subprocess.shellPath ?? '')
      this.deps.subprocess.write(
        buildStartupCommandSubmission(
          appendNativeSetupCompletion(
            command,
            token,
            this.nativeSetupShell ??
              (process.platform === 'win32' && (shell === 'cmd' || shell === 'powershell')
                ? shell
                : undefined)
          ),
          { bracketedPasteSafe }
        )
      )
    }
  }

  ingestSubprocessData(data: string): void {
    let releaseStartupDeviceAttributes = false
    let emitted = false
    if (this._state === 'pending' && this.scanState) {
      const scanned = scanShellStartupOutput(this.scanState, data, (part, removed) => {
        emitted = true
        this.deps.acceptStartupIngress(part, removed)
      })
      data = scanned.output
      if (scanned.shellPid) {
        this.shellStartupPid = scanned.shellPid
      }
      if (scanned.ready) {
        if (this.deps.nativeSetupToken && this.shellStartupPid && process.platform !== 'win32') {
          void readMatchingPromptShellExecutable({
            shellPid: this.shellStartupPid,
            shellPath: this.deps.subprocess.shellPath,
            shellCwd: this.deps.subprocess.shellCwd ?? process.cwd(),
            shellPathEnv: this.deps.subprocess.shellPathEnv
          }).then(
            (executable) => {
              if (this._state !== 'pending' || !this.scanState) {
                return
              }
              this.nativeSetupShell = executable
                ? nativeSetupCompletionShell(executable)
                : undefined
              this.transitionToReady(scanned.postMarkerBytesObserved)
              this.releaseDeviceAttributes()
            },
            () => {
              if (this._state === 'pending' && this.scanState) {
                this.transitionToReady(scanned.postMarkerBytesObserved)
                this.releaseDeviceAttributes()
              }
            }
          )
        } else {
          this.nativeSetupShell =
            process.platform === 'win32' ? scanned.nativeSetupShell : undefined
          this.transitionToReady(scanned.postMarkerBytesObserved)
        }
        releaseStartupDeviceAttributes = true
      }
    } else {
      this.postReadyFlushGate.notifyData()
    }

    if (!emitted) {
      this.deps.acceptStartupIngress(data)
    }
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
      this.deps.subprocess.write(
        data.startup
          ? buildStartupCommandSubmission(
              appendNativeSetupCompletion(
                data.startup.command,
                data.startup.token,
                this.nativeSetupShell
              ),
              { bracketedPasteSafe: data.startup.bracketedPasteSafe }
            )
          : data.data
      )
    }
  }
}
