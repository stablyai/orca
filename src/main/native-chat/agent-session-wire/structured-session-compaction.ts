import { providerDiagnostic, type ProviderDiagnostic } from '../../../shared/agent-session-failure'

/** How a compaction ended. `unconfirmed`: the provider never said whether it compacted, so it may
 *  have. `detail` is the provider's own words for a failure, when it gave any. */
export type StructuredSessionCompactionResult =
  | { outcome: 'compacted' }
  | { outcome: 'failed'; detail?: ProviderDiagnostic }
  | { outcome: 'unconfirmed' }

/** A compaction that never began: refused before it was sent, or by the provider at the request. */
export type StructuredSessionCompactionRefusal = Extract<
  StructuredSessionCompactionResult,
  { outcome: 'failed' }
>

function compactionFailed(
  detail: ProviderDiagnostic | undefined
): StructuredSessionCompactionRefusal {
  return { outcome: 'failed', ...(detail ? { detail } : {}) }
}

type PendingCompaction = {
  identity: string
  commandTurnId?: string
  turnId?: string
  /** The provider reported the compaction failed, with its words when it gave any. */
  failed?: { detail?: ProviderDiagnostic }
  compacted: boolean
  finish: (result: StructuredSessionCompactionResult) => void
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function isCodexCompactionComplete(method: string, params: unknown): boolean {
  return (
    method === 'thread/compacted' ||
    (method === 'item/completed' && record(record(params).item).type === 'contextCompaction')
  )
}

/** A receipt is not completion; keep listening through the provider's terminal frame. */
export class StructuredSessionCompaction {
  private readonly pending = new Map<string, PendingCompaction>()
  constructor(private readonly timeoutMs = 180_000) {}

  async run(
    sessionId: string,
    identity: string,
    invoke: () => Promise<StructuredSessionCompactionRefusal | undefined>,
    onLateResult?: (result: StructuredSessionCompactionResult) => Promise<void>,
    commandTurnId?: string
  ): Promise<StructuredSessionCompactionResult> {
    if (this.pending.has(sessionId)) {
      throw new Error('Compaction is already running.')
    }
    let timer: ReturnType<typeof setTimeout>
    let expired = false
    const completion = new Promise<StructuredSessionCompactionResult>((resolve, reject) => {
      const finish = (result: StructuredSessionCompactionResult) => {
        this.pending.delete(sessionId)
        if (expired && onLateResult) {
          void onLateResult(result).catch((error) =>
            console.warn('Could not persist late compaction completion', error)
          )
        }
        resolve(result)
      }
      this.pending.set(sessionId, {
        identity,
        commandTurnId,
        compacted: false,
        finish
      })
      timer = setTimeout(() => {
        expired = true
        reject(new Error('Compaction completion is unconfirmed.'))
      }, this.timeoutMs)
      timer.unref?.()
    })
    // Observe rejection even while invoke is waiting for its own receipt.
    void completion.catch(() => {})
    try {
      const refusal = await invoke()
      if (refusal) {
        this.pending.get(sessionId)?.finish(compactionFailed(refusal.detail))
      }
      return await completion
    } catch (error) {
      expired = this.pending.has(sessionId)
      throw error
    } finally {
      clearTimeout(timer!)
      if (!expired) {
        this.pending.delete(sessionId)
      }
    }
  }

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  ownsTurn(sessionId: string, turnId: string): boolean {
    return this.pending.get(sessionId)?.commandTurnId === turnId
  }

  providerTurnId(sessionId: string, turnId: string): string | undefined {
    return this.ownsTurn(sessionId, turnId) ? this.pending.get(sessionId)?.turnId : turnId
  }

  ended(sessionId: string): void {
    // It may have compacted before it exited.
    this.pending.get(sessionId)?.finish({ outcome: 'unconfirmed' })
  }

  codex(sessionId: string, method: string, value: unknown): void {
    const pending = this.pending.get(sessionId)
    const params = record(value)
    if (!pending || params.threadId !== pending.identity) {
      return
    }
    const turn = record(params.turn)
    if (method === 'turn/started' && typeof turn.id === 'string') {
      pending.turnId = turn.id
    }
    if (isCodexCompactionComplete(method, params)) {
      pending.compacted = true
    }
    if (method === 'turn/completed' && turn.id === pending.turnId) {
      const error = record(turn.error).message
      pending.finish(
        turn.status !== 'completed'
          ? compactionFailed(
              typeof error === 'string' ? providerDiagnostic(error, 'person') : undefined
            )
          : { outcome: pending.compacted ? 'compacted' : 'unconfirmed' }
      )
    }
  }

  claude(sessionId: string, message: Record<string, unknown>): void {
    const pending = this.pending.get(sessionId)
    if (!pending || message.session_id !== pending.identity) {
      return
    }
    if (message.compact_result === 'failed') {
      pending.failed = {
        detail:
          typeof message.compact_error === 'string'
            ? providerDiagnostic(message.compact_error, 'person')
            : undefined
      }
    }
    if (message.compact_result === 'success' || message.subtype === 'compact_boundary') {
      pending.compacted = true
    }
    if (message.type === 'result') {
      if (
        message.is_error === true ||
        (typeof message.subtype === 'string' && message.subtype.startsWith('error'))
      ) {
        pending.failed ??= {}
      }
      pending.finish(
        pending.failed
          ? compactionFailed(pending.failed.detail)
          : { outcome: pending.compacted ? 'compacted' : 'unconfirmed' }
      )
    }
  }
}
