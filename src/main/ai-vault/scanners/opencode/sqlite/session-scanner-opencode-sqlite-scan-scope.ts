import { AsyncLocalStorage } from 'node:async_hooks'
import { throwIfSignalAborted } from '../../../../../shared/concurrency/abort-signal-reason'
import type { WorkerThreadRequestOwner } from '../../../../worker-threads/worker-thread-request-queue'
import type { SqliteReaderAgent } from '../reader-transport/session-scanner-opencode-sqlite-worker-protocol'

export const OPENCODE_SQLITE_SCAN_BUDGET_MS = 45_000

class OpenCodeSqliteScanScope implements WorkerThreadRequestOwner {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private remainingMs = OPENCODE_SQLITE_SCAN_BUDGET_MS
  private outstanding = 0
  private armedAt = 0
  private timer: NodeJS.Timeout | undefined

  async run<T>(
    callerSignal: AbortSignal | undefined,
    fn: (signal: AbortSignal, owner: WorkerThreadRequestOwner) => Promise<T>
  ): Promise<T> {
    throwIfSignalAborted(callerSignal)
    throwIfSignalAborted(this.signal)
    if (this.outstanding++ === 0) {
      this.armedAt = Date.now()
      this.timer = setTimeout(() => {
        const error = new Error(
          `OpenCode SQLite scan exceeded its ${OPENCODE_SQLITE_SCAN_BUDGET_MS / 1000}s work budget`
        )
        error.name = 'OpenCodeSqliteScanDeadlineError'
        this.controller.abort(error)
      }, this.remainingMs)
      this.timer.unref?.()
    }
    const signal = callerSignal ? AbortSignal.any([callerSignal, this.signal]) : this.signal
    try {
      return await fn(signal, this)
    } finally {
      if (--this.outstanding === 0) {
        this.pause()
      }
    }
  }

  dispose(): void {
    this.pause()
    this.controller.abort(new Error('OpenCode SQLite scan ended'))
  }

  private pause(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.armedAt))
    }
  }
}

const scanScope = new AsyncLocalStorage<OpenCodeSqliteScanScope>()

export async function withOpenCodeSqliteScanScope<T>(fn: () => Promise<T>): Promise<T> {
  const scope = new OpenCodeSqliteScanScope()
  try {
    return await scanScope.run(scope, fn)
  } finally {
    scope.dispose()
  }
}

// The clock covers outstanding SQLite work, including admission and WSL preparation.
export function runOpenCodeSqliteScanRequest<T>(
  signal: AbortSignal | undefined,
  fn: (signal?: AbortSignal, owner?: WorkerThreadRequestOwner) => Promise<T>,
  agent?: SqliteReaderAgent | 'native-chat'
): Promise<T> {
  // Only OpenCode's stores share the scan budget; ZCode and Hermes keep their own databases.
  const scope = agent === 'opencode2' || agent === undefined ? scanScope.getStore() : undefined
  return scope ? scope.run(signal, fn) : fn(signal)
}
