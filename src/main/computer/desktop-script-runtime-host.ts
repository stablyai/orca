import { spawnProcess } from '@orca/process-host'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import { reportComputerDiagnostic } from './computer-sidecar-diagnostics'
import { isReplayableTool } from './desktop-script-action'
import type { BridgeRequest, BridgeResponse } from './desktop-script-provider-types'
import { DesktopScriptRequestQueue } from './desktop-script-request-queue'
import {
  startServeChannel,
  type DesktopScriptServeChannel,
  type RuntimeProcessSpawn
} from './desktop-script-serve-channel'
import {
  MAX_START_ATTEMPTS,
  RuntimeHostAvailability,
  START_FAILURE_COOLDOWN_MS
} from './desktop-script-runtime-availability'
import { RuntimeClientError } from './runtime-client-error'
import {
  isExecutionPolicyBlocked,
  windowsPowerShellRuntimeArgs
} from './windows-powershell-execution-policy'

const REQUEST_TIMEOUT_MS = 30_000
const IDLE_SHUTDOWN_MS = 120_000

/** Signals that this operation may fall back to the one-shot bridge. */
export const RUNTIME_HOST_UNAVAILABLE = 'runtime_host_unavailable'

export type DesktopScriptRuntimeHostOptions = {
  spawn?: RuntimeProcessSpawn
  powerShellPath?: () => string
  requestTimeoutMs?: number
  idleShutdownMs?: number
  cooldownMs?: number
  now?: () => number
  warn?: (message: string) => void
}

type PendingRequest = {
  id: number
  resolve: (response: BridgeResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export function isRuntimeHostUnavailable(error: unknown): boolean {
  return error instanceof RuntimeClientError && error.code === RUNTIME_HOST_UNAVAILABLE
}

/** Reuse one PowerShell process to avoid repeated Add-Type compilation and EDR process bursts. */
export class DesktopScriptRuntimeHost {
  private channel: DesktopScriptServeChannel | null = null
  private pending: PendingRequest | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private childReady = false
  private childAnswered = false
  /** Legacy override scripts may omit readiness; require protocol proof before replaying mutations. */
  private readyProtocolConfirmed = false
  private disposed = false
  private nextRequestId = 1
  private readonly availability: RuntimeHostAvailability
  private readonly queue: DesktopScriptRequestQueue
  private readonly requestTimeoutMs: number
  private readonly idleShutdownMs: number

  constructor(
    private readonly scriptPath: string,
    private readonly options: DesktopScriptRuntimeHostOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.idleShutdownMs = options.idleShutdownMs ?? IDLE_SHUTDOWN_MS
    this.queue = new DesktopScriptRequestQueue(this.requestTimeoutMs, () => this.armIdleTimer())
    this.availability = new RuntimeHostAvailability(
      options.cooldownMs ?? START_FAILURE_COOLDOWN_MS,
      (message) => (options.warn ?? reportComputerDiagnostic)(message),
      options.now
    )
  }

  request(request: BridgeRequest): Promise<BridgeResponse> {
    return this.queue.enqueue(() => this.send(request))
  }

  dispose(): void {
    this.disposed = true
    this.clearIdleTimer()
    this.availability.clearCooldown()
    this.stopChannel()
    this.rejectPending(
      new RuntimeClientError('accessibility_error', 'desktop provider runtime host was shut down')
    )
  }

  private async send(request: BridgeRequest): Promise<BridgeResponse> {
    this.clearIdleTimer()
    // Disposal can occur while a request queues; never respawn a helper after teardown.
    if (this.disposed) {
      throw this.unavailableError('runtime host was disposed')
    }
    const cooldown = this.availability.remainingCooldown()
    if (cooldown > 0) {
      throw this.unavailableError(`retrying the runtime host in ${cooldown}ms`)
    }
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
      try {
        const response = await this.sendOnce(request)
        this.availability.recordSuccess()
        return response
      } catch (error) {
        lastError = error
        if (this.availability.policyRetryPending) {
          this.availability.escalateExecutionPolicy()
          continue
        }
        // A start failure leaves the fallback unproven; a later crash does not.
        if (isRuntimeHostUnavailable(error)) {
          this.availability.abandonUnprovenFallback()
        }
        // Never replay an operation after the helper could have delivered input.
        if (!isRuntimeHostUnavailable(error) || !this.mayReplay(request)) {
          if (this.availability.exhausted) {
            this.availability.enterCooldown()
          }
          throw error
        }
        this.availability.warn(
          `runtime host failed to start (attempt ${attempt}/${MAX_START_ATTEMPTS}): ${errorText(error)}`
        )
      }
    }
    this.availability.enterCooldown()
    throw lastError
  }

  private sendOnce(request: BridgeRequest): Promise<BridgeResponse> {
    let channel: DesktopScriptServeChannel
    try {
      channel = this.ensureChannel()
    } catch (error) {
      this.availability.recordFailure()
      return Promise.reject(this.unavailableError(errorText(error)))
    }
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      // A hung native UI Automation call can only be interrupted by stopping its process.
      const timer = setTimeout(() => {
        this.abortChannel(
          new RuntimeClientError(
            'action_timeout',
            `desktop provider timed out after ${this.requestTimeoutMs}ms`
          )
        )
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending = { id, resolve, reject, timer }
      channel.write(`${JSON.stringify({ ...request, requestId: id })}\n`, (error) => {
        // A late write callback may belong to a replaced channel or an already-answered request.
        if (this.channel !== channel || this.pending?.id !== id) {
          return
        }
        this.abortChannel(new RuntimeClientError('accessibility_error', error.message))
      })
    })
  }

  private ensureChannel(): DesktopScriptServeChannel {
    if (this.channel) {
      return this.channel
    }
    this.childReady = false
    this.childAnswered = false
    const channel: DesktopScriptServeChannel = startServeChannel(
      {
        program: (this.options.powerShellPath ?? windowsPowerShellPath)(),
        args: windowsPowerShellRuntimeArgs(this.scriptPath, this.availability.executionPolicy, [
          '-Serve'
        ]),
        env: process.env
      },
      this.options.spawn ?? spawnProcess,
      {
        onLine: (line) => this.deliver(line),
        // A replaced channel can still report; that must not fail the live one.
        onGone: (detail) => {
          if (this.channel === channel) {
            this.handleGone(detail)
          }
        },
        onOverflow: () =>
          this.abortChannel(
            new RuntimeClientError(
              'accessibility_error',
              'desktop provider response exceeded the runtime host buffer'
            )
          )
      }
    )
    this.channel = channel
    return channel
  }

  /** Replay mutations only after a protocol-confirmed helper fails before announcing readiness. */
  private mayReplay(request: BridgeRequest): boolean {
    if (this.childReady || this.childAnswered) {
      return false
    }
    return this.readyProtocolConfirmed || isReplayableTool(request.tool)
  }

  private deliver(line: string): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Ignore console noise; request IDs correlate actual responses.
      return
    }
    if (parsed.ready === true && parsed.requestId === undefined) {
      this.childReady = true
      this.readyProtocolConfirmed = true
      this.availability.confirmExecutionPolicy()
      return
    }
    const pending = this.pending
    if (!pending || parsed.requestId !== pending.id) {
      // Stop desynchronized replies, retaining the helper's error so the original cause remains visible.
      const reported = typeof parsed.error === 'string' ? `: ${parsed.error}` : ''
      this.abortChannel(
        new RuntimeClientError(
          'accessibility_error',
          `desktop provider response did not match the pending request${reported}`
        )
      )
      return
    }
    this.childAnswered = true
    this.pending = null
    clearTimeout(pending.timer)
    const { requestId: _echoed, ...response } = parsed
    pending.resolve(response as BridgeResponse)
  }

  private handleGone(detail: string): void {
    const started = this.childReady || this.childAnswered
    this.channel = null
    this.availability.recordFailure()
    if (!started && this.availability.atPreferredPolicy && isExecutionPolicyBlocked(detail)) {
      this.availability.requestPolicyRetry()
      // Preserve one-shot fallback, including its policy retry, when host attempts run out.
      this.rejectPending(this.unavailableError(detail))
      return
    }
    if (!started) {
      this.rejectPending(this.unavailableError(detail))
      return
    }
    this.rejectPending(
      new RuntimeClientError(
        'accessibility_error',
        `desktop provider runtime host exited: ${detail}`
      )
    )
  }

  /** Count host-detected aborts too: stopping the channel suppresses its exit handler. */
  private abortChannel(error: Error): void {
    this.stopChannel()
    this.availability.recordFailure()
    this.availability.warn(`runtime host helper stopped: ${error.message}`)
    this.rejectPending(error)
  }

  private stopChannel(): void {
    const channel = this.channel
    this.channel = null
    channel?.stop()
  }

  private takePending(): PendingRequest | null {
    const pending = this.pending
    this.pending = null
    if (pending) {
      clearTimeout(pending.timer)
    }
    return pending
  }

  private rejectPending(error: Error): void {
    this.takePending()?.reject(error)
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    if (!this.channel) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.stopChannel()
    }, this.idleShutdownMs)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private unavailableError(message: string): RuntimeClientError {
    return new RuntimeClientError(
      RUNTIME_HOST_UNAVAILABLE,
      `desktop provider runtime host could not start: ${message}`
    )
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
