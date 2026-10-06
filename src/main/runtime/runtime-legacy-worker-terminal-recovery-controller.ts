import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import { runLegacyWorkerTerminalRecovery } from './runtime-legacy-worker-terminal-recovery-runner'
import type {
  LegacyWorkerRecoveryOptions,
  LegacyWorkerRecoveryPorts,
  LegacyWorkerTerminalRecoveryResult
} from './runtime-legacy-worker-terminal-recovery-types'

type RecoveryRetry = {
  attempt: number
  dispatchIds: string[]
  connectionId?: string
  materializeRenderer: boolean
  timer: ReturnType<typeof setTimeout> | null
}

// Retain controllers only while timers need cancellation during test teardown.
const controllersWithArmedRetries = new Set<RuntimeLegacyWorkerTerminalRecoveryController>()

/** Stop every armed recovery retry. Test-only: a retry loop must not outlive the test that armed it. */
export function __cancelLegacyWorkerTerminalRecoveryRetriesForTests(): void {
  for (const controller of Array.from(controllersWithArmedRetries)) {
    controller.cancelAllRetries()
  }
}

export class RuntimeLegacyWorkerTerminalRecoveryController {
  private queue: Promise<void> = Promise.resolve()
  private readonly retries = new Map<string, RecoveryRetry>()
  private readonly receiptEpochByPane = new Map<string, number>()
  private readonly recoveredPtys = new Set<string>()

  constructor(private readonly ports: LegacyWorkerRecoveryPorts) {}

  reconcile(
    options: LegacyWorkerRecoveryOptions = {}
  ): Promise<LegacyWorkerTerminalRecoveryResult> {
    if (!options.retry) {
      this.cancelScope(options.connectionId ? `ssh:${options.connectionId}` : 'local')
    }
    let resolveResult!: (result: LegacyWorkerTerminalRecoveryResult) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<LegacyWorkerTerminalRecoveryResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const run = this.queue.then(async () => {
      try {
        if (!options.retry) {
          this.cancelScope(options.connectionId ? `ssh:${options.connectionId}` : 'local')
        }
        resolveResult(await runLegacyWorkerTerminalRecovery(this, this.ports, options))
      } catch (error) {
        rejectResult(error)
      }
    })
    this.queue = run.catch(() => undefined)
    return result
  }

  cancelScope(scopeKey: string): void {
    const retry = this.retries.get(scopeKey)
    if (retry?.timer) {
      clearTimeout(retry.timer)
    }
    this.retries.delete(scopeKey)
    if (![...this.retries.values()].some((entry) => entry.timer !== null)) {
      controllersWithArmedRetries.delete(this)
    }
  }

  cancelAllRetries(): void {
    for (const scopeKey of Array.from(this.retries.keys())) {
      this.cancelScope(scopeKey)
    }
  }

  updateRetry(
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: LegacyWorkerRecoveryOptions
  ): void {
    const scopeKey = options.connectionId ? `ssh:${options.connectionId}` : 'local'
    const dispatchIds = plan.candidates.flatMap((candidate) => {
      const sshPty = parseAppSshPtyId(candidate.ptyId)
      const ptyHost = getPtyExecutionHost(candidate.ptyId)
      if (ptyHost === 'foreign' || (ptyHost !== null && !sshPty)) {
        return []
      }
      const inScope = options.connectionId
        ? sshPty?.connectionId === options.connectionId
        : sshPty === null
      return inScope && deferredDispatchIds.has(candidate.dispatchId) ? [candidate.dispatchId] : []
    })
    if (dispatchIds.length === 0) {
      this.cancelScope(scopeKey)
      return
    }
    const retry = this.retries.get(scopeKey) ?? {
      attempt: 0,
      dispatchIds,
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      materializeRenderer: options.materializeRenderer === true,
      timer: null
    }
    retry.materializeRenderer ||= options.materializeRenderer === true
    retry.dispatchIds = dispatchIds
    this.retries.set(scopeKey, retry)
    this.armRetry(scopeKey, retry)
  }

  hasReceipt(paneKey: string, epoch: number): boolean {
    return this.receiptEpochByPane.get(paneKey) === epoch
  }

  setReceipt(paneKey: string, epoch: number): void {
    this.receiptEpochByPane.set(paneKey, epoch)
  }

  deleteReceipt(paneKey: string): void {
    this.receiptEpochByPane.delete(paneKey)
  }

  addRecoveredPty(ptyId: string): void {
    this.recoveredPtys.add(ptyId)
  }

  deleteRecoveredPty(ptyId: string): void {
    this.recoveredPtys.delete(ptyId)
  }

  hasRecoveredPty(ptyId: string): boolean {
    return this.recoveredPtys.has(ptyId)
  }

  private armRetry(scopeKey: string, retry: RecoveryRetry): void {
    if (retry.timer) {
      return
    }
    const delayMs = Math.min(1_000 * 2 ** retry.attempt, 30_000)
    retry.attempt = Math.min(retry.attempt + 1, 5)
    retry.timer = setTimeout(() => {
      retry.timer = null
      void this.ports
        .reconcile({
          retry: true,
          dispatchIds: retry.dispatchIds,
          ...(retry.connectionId ? { connectionId: retry.connectionId } : {}),
          materializeRenderer: retry.materializeRenderer
        })
        .catch((error) => {
          console.warn('[orchestration] worker terminal recovery retry failed', {
            scope: scopeKey,
            error
          })
          if (this.retries.get(scopeKey) === retry) {
            this.armRetry(scopeKey, retry)
          }
        })
    }, delayMs)
    retry.timer.unref?.()
    controllersWithArmedRetries.add(this)
  }
}
