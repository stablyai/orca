import { spawnProcess } from '../../shared/child-process/run-process'
import { windowsPowerShellPath } from '../../shared/child-process/windows-system-binary'
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

/** Code the client keys on to serve this one operation from the one-shot bridge. */
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

/**
 * One long-lived `runtime.ps1 -Serve` process serving every computer-use
 * operation over NDJSON on stdin/stdout.
 *
 * Why persistent: the one-shot bridge started a powershell.exe per click, and
 * each one re-emitted the script's inline `Add-Type` P/Invoke assembly, which
 * Defender for Endpoint reports as suspicious MSIL emission alongside the
 * screen capture. Compiling once per session collapses a burst of short-lived
 * PIDs into a single process.
 *
 * Requests are strictly serialized, and each carries an id the helper echoes.
 * Serialization alone would leave a single stray line answering every later
 * request with the previous response — silently acting on stale element
 * indexes, with no error raised — so the id is checked and a mismatch is fatal
 * to the child rather than merely logged.
 */
export class DesktopScriptRuntimeHost {
  private channel: DesktopScriptServeChannel | null = null
  private pending: PendingRequest | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private childReady = false
  private childAnswered = false
  /**
   * Set once any helper has announced itself, which proves the script on disk
   * speaks the ready protocol. Until then a mutating request is not replayed
   * even on a clean start failure, because ORCA_COMPUTER_DESKTOP_SCRIPT_PROVIDER_PATH
   * can point at an older runtime.ps1 that simply never announces.
   */
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

  /** Permanently stop this host. Callers build a new one for a new session. */
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
    // Why checked here and not only on entry: requests queue, and dispose can
    // land while one waits its turn. Without this a teardown respawns a helper.
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
        // Only this error proves no helper started, which is what disproves the
        // escalation; a helper that started and then died proves the opposite.
        if (isRuntimeHostUnavailable(error)) {
          this.availability.abandonUnprovenFallback()
        }
        // A helper that answered and then died is a crash, not a bad start: the
        // caller sees it and the next operation gets a fresh process — unless it
        // keeps happening, which is thrash the one-shot bridge should absorb.
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
      // Why kill rather than wait: a hung UI Automation call cannot be
      // cancelled, so the process itself is the only thing left to reclaim.
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
        // Bind the report to what it was written for: a late callback must not
        // charge a second failure for this operation, nor stop a replacement
        // helper and reject a later request with this one's error. Deliberately
        // redundant with the channel's own closed guard — keep both. This one
        // also covers a live channel whose request has already been answered,
        // which the channel cannot see; that case is what pins it.
        //
        // Redundant does not mean untested: removing either guard alone fails a
        // test, so neither can be deleted as "the one the other covers".
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

  /**
   * Whether the helper that just died can be proved not to have run the request.
   *
   * Why proof and not inference: "no reply came back" is not "nothing happened".
   * runtime.ps1 synthesizes the input and only then builds the snapshot, which
   * allocates a full-window bitmap and walks the UIA tree — a native fault there
   * is uncatchable and would leave a click already delivered. Retrying on that
   * inference turns one requested click into four.
   */
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
      // Not a response at all — a PowerShell banner, a stray write. Dropping it
      // is safe now that the id below is what decides which request is answered,
      // and it keeps a chatty console from making the helper unusable.
      return
    }
    // The readiness announcement carries no request id and answers nothing.
    if (parsed.ready === true && parsed.requestId === undefined) {
      this.childReady = true
      this.readyProtocolConfirmed = true
      this.availability.confirmExecutionPolicy()
      return
    }
    const pending = this.pending
    if (!pending || parsed.requestId !== pending.id) {
      // One unmatched reply would otherwise shift every later response by one.
      // Carry the helper's own message when it sent one: a line it could not tag
      // with an id is usually the only account of what went wrong, and reporting
      // a bare desync in its place loses the cause for good.
      const reported = typeof parsed.error === 'string' ? `: ${parsed.error}` : ''
      this.abortChannel(
        new RuntimeClientError(
          'accessibility_error',
          `desktop provider response did not match the pending request${reported}`
        )
      )
      return
    }
    // Only a reply this host can prove is its own counts as the helper working.
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
      // Unavailable rather than a generic error, because this can now be the
      // final attempt: reverting an unproven escalation puts the host back on
      // the preferred policy, so a later attempt can land here again. Only this
      // code routes the operation to the one-shot bridge, which carries its own
      // policy fallback; anything else fails the operation outright.
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

  /**
   * Stop a helper this host has judged unusable — a timeout, a desynchronised
   * reply, an oversized line.
   *
   * Why it counts as a failure: stopping the channel suppresses the exit
   * handler, so without this these paths bypassed the accounting entirely and a
   * helper that failed this way on every operation was respawned once per
   * operation forever — the burst this host exists to remove, restored through
   * its own recovery path.
   */
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
