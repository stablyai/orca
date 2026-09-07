import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import { runLegacyWorkerTerminalRecovery } from './runtime-legacy-worker-terminal-recovery-runner'
import type {
  LegacyWorkerRecoveryOptions,
  LegacyWorkerRecoveryPorts,
  LegacyWorkerTerminalRecoveryResult
} from './runtime-legacy-worker-terminal-recovery-types'

type RecoveryRetry = {
  attempt: number
  connectionId?: string
  materializeRenderer: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class RuntimeLegacyWorkerTerminalRecoveryController {
  private queue: Promise<void> = Promise.resolve()
  private readonly retries = new Map<string, RecoveryRetry>()
  private readonly receiptEpochByPane = new Map<string, number>()
  private readonly recoveredPtys = new Set<string>()

  constructor(private readonly ports: LegacyWorkerRecoveryPorts) {}

  prepare(): LegacyWorkerTerminalRecoveryPlan {
    return this.ports.preparePlan()
  }

  reconcile(
    options: LegacyWorkerRecoveryOptions = {}
  ): Promise<LegacyWorkerTerminalRecoveryResult> {
    let resolveResult!: (result: LegacyWorkerTerminalRecoveryResult) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<LegacyWorkerTerminalRecoveryResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const run = this.queue.then(async () => {
      try {
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
  }

  updateRetry(
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: LegacyWorkerRecoveryOptions
  ): void {
    const scopeKey = options.connectionId ? `ssh:${options.connectionId}` : 'local'
    const hasDeferredWorker = plan.candidates.some((candidate) => {
      const sshPty = parseAppSshPtyId(candidate.ptyId)
      const inScope = options.connectionId
        ? sshPty?.connectionId === options.connectionId
        : sshPty === null
      return inScope && deferredDispatchIds.has(candidate.dispatchId)
    })
    if (!hasDeferredWorker) {
      this.cancelScope(scopeKey)
      return
    }
    const retry = this.retries.get(scopeKey) ?? {
      attempt: 0,
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      materializeRenderer: options.materializeRenderer === true,
      timer: null
    }
    retry.materializeRenderer ||= options.materializeRenderer === true
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
    retry.attempt += 1
    retry.timer = setTimeout(() => {
      retry.timer = null
      void this.ports
        .reconcile({
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
  }
}
