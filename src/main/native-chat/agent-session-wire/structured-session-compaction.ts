type PendingCompaction = {
  identity: string
  commandTurnId?: string
  turnId?: string
  error?: string
  compacted: boolean
  finish: (result: { error?: string }) => void
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** A receipt is not completion; keep listening through the provider's terminal frame. */
export class StructuredSessionCompaction {
  private readonly pending = new Map<string, PendingCompaction>()
  constructor(private readonly timeoutMs = 180_000) {}

  async run(
    sessionId: string,
    identity: string,
    invoke: () => Promise<unknown>,
    onLateResult?: (result: { error?: string }) => Promise<void>,
    commandTurnId?: string
  ): Promise<{ error?: string }> {
    if (this.pending.has(sessionId)) {
      throw new Error('Compaction is already running.')
    }
    let timer: ReturnType<typeof setTimeout>
    let expired = false
    const completion = new Promise<{ error?: string }>((resolve, reject) => {
      const finish = (result: { error?: string }) => {
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
      const admission = record(await invoke())
      if (typeof admission.error === 'string') {
        this.pending.get(sessionId)?.finish({ error: admission.error })
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
    this.pending.get(sessionId)?.finish({ error: 'The provider exited during compaction.' })
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
    if (
      method === 'thread/compacted' ||
      (method === 'item/completed' && record(params.item).type === 'contextCompaction')
    ) {
      pending.compacted = true
    }
    if (method === 'turn/completed' && turn.id === pending.turnId) {
      const error = record(turn.error).message
      pending.finish(
        turn.status === 'completed' && pending.compacted
          ? {}
          : { error: typeof error === 'string' ? error : 'Compaction did not complete.' }
      )
    }
  }

  claude(sessionId: string, message: Record<string, unknown>): void {
    const pending = this.pending.get(sessionId)
    if (!pending || message.session_id !== pending.identity) {
      return
    }
    if (message.compact_result === 'failed') {
      pending.error =
        typeof message.compact_error === 'string' ? message.compact_error : 'Compaction failed.'
    }
    if (message.compact_result === 'success' || message.subtype === 'compact_boundary') {
      pending.compacted = true
    }
    if (message.type === 'result') {
      if (
        message.is_error === true ||
        (typeof message.subtype === 'string' && message.subtype.startsWith('error'))
      ) {
        pending.error ??= 'Compaction did not complete.'
      }
      const error =
        pending.error ??
        (pending.compacted ? undefined : 'Compaction was not confirmed by the provider.')
      pending.finish(error ? { error } : {})
    }
  }
}
