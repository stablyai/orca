import type { CliStatusResult } from '../../shared/runtime-types'
import { launchOrcaApp } from './launch'
import { getDefaultUserDataPath, readMetadata } from './metadata'
import { getCliStatus } from './status'
import { sendRequest } from './transport'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcSuccess } from './types'

// Why: for `orchestration.check --wait` the caller's method-level
// `params.timeoutMs` is the inner waiter budget; we extend the client-side
// socket timeout to `timeoutMs + GRACE_MS` so the client's own idle timer
// never fires before the server-side waiter has had a chance to resolve and
// emit its terminal frame. The 10 s grace absorbs round-trip + one final
// keepalive window. See design doc §3.1.
const LONG_POLL_CLIENT_GRACE_MS = 10_000

export class RuntimeClient {
  private readonly userDataPath: string
  private readonly requestTimeoutMs: number

  // Why: browser commands trigger first-time session init (agent-browser connect +
  // CDP proxy setup) which can take 15-30s. 60s accommodates cold start without
  // being so large that genuine hangs go unnoticed.
  constructor(userDataPath = getDefaultUserDataPath(), requestTimeoutMs = 60_000) {
    this.userDataPath = userDataPath
    this.requestTimeoutMs = requestTimeoutMs
  }

  async call<TResult>(
    method: string,
    params?: unknown,
    options?: {
      timeoutMs?: number
    }
  ): Promise<RuntimeRpcSuccess<TResult>> {
    const metadata = readMetadata(this.userDataPath)
    const effectiveTimeoutMs = options?.timeoutMs ?? this.resolveMethodTimeoutMs(method, params)
    const response = await sendRequest<TResult>(metadata, method, params, effectiveTimeoutMs)
    if (!response.ok) {
      throw new RuntimeRpcFailureError(response)
    }
    return response
  }

  // Why: centralises the per-method timeout policy. `orchestration.check` with
  // `wait: true` is the only long-poll today, and its inner waiter budget
  // lives in `params.timeoutMs`. We widen the client-side socket timeout to
  // `timeoutMs + grace` so it doesn't fire before the server has a chance to
  // resolve. Without this, a 5 min wait would still die at the 60 s default.
  // See design doc §3.1.
  private resolveMethodTimeoutMs(method: string, params?: unknown): number {
    if (method === 'orchestration.check' && isWaitingCheck(params)) {
      const inner = Number((params as { timeoutMs?: unknown }).timeoutMs)
      if (Number.isFinite(inner) && inner > 0) {
        return Math.max(inner + LONG_POLL_CLIENT_GRACE_MS, this.requestTimeoutMs)
      }
    }
    return this.requestTimeoutMs
  }

  async getCliStatus(): Promise<RuntimeRpcSuccess<CliStatusResult>> {
    return getCliStatus(this.userDataPath)
  }

  async openOrca(timeoutMs = 15_000): Promise<RuntimeRpcSuccess<CliStatusResult>> {
    const initial = await this.getCliStatus()
    if (initial.result.runtime.reachable) {
      return initial
    }

    launchOrcaApp()
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.getCliStatus()
      if (status.result.runtime.reachable) {
        return status
      }
      await delay(250)
    }

    throw new RuntimeClientError(
      'runtime_open_timeout',
      'Timed out waiting for Orca to start. Run the Orca app manually and try again.'
    )
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isWaitingCheck(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    'wait' in params &&
    (params as { wait: unknown }).wait === true
  )
}
