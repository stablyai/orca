type PendingCompaction = {
  identity: string
  commandTurnId?: string
  turnId?: string
  claudeLifecycleExpected: boolean
  claudeLifecycleObserved: boolean
  error?: string
  compacted: boolean
  interrupted: boolean
  finish: (result: { error?: string }) => void
  interrupt: () => void
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
    invoke: () => Promise<unknown>,
    onLateResult?: (result: { error?: string }) => Promise<void>,
    commandTurnId?: string
  ): Promise<{ error?: string }> {
    const current = this.pending.get(sessionId)
    if (current) {
      return {
        error: current.interrupted
          ? 'The interrupted compaction is still settling.'
          : 'Compaction is already running.'
      }
    }
    let expired = false
    const completion = Promise.withResolvers<{ error?: string }>()
    const pending: PendingCompaction = {
      identity,
      commandTurnId,
      claudeLifecycleExpected: false,
      claudeLifecycleObserved: false,
      compacted: false,
      interrupted: false,
      finish: (result) => {
        if (this.pending.get(sessionId) !== pending) {
          return
        }
        this.pending.delete(sessionId)
        if ((expired || pending.interrupted) && onLateResult) {
          void onLateResult(result).catch((error) =>
            console.warn('Could not persist late compaction completion', error)
          )
        }
        completion.resolve(result)
      },
      interrupt: () => {
        if (this.pending.get(sessionId) !== pending || pending.interrupted) {
          return
        }
        // The provider's interrupt receipt can precede its terminal frame. Retain this generation
        // until that frame arrives so it cannot be mistaken for a later compaction.
        pending.interrupted = true
        completion.reject(new Error('Compaction was interrupted.'))
      }
    }
    this.pending.set(sessionId, pending)
    const timer = setTimeout(() => {
      expired = true
      completion.reject(new Error('Compaction completion is unconfirmed.'))
    }, this.timeoutMs)
    timer.unref?.()
    // Observe rejection even while invoke is waiting for its own receipt.
    void completion.promise.catch(() => {})
    const invocation = Promise.resolve()
      .then(invoke)
      .then((value) => {
        const admission = record(value)
        if (typeof admission.error === 'string') {
          pending.finish({ error: admission.error })
        }
        return completion.promise
      })
    try {
      // The completion window also bounds a missing request receipt. Provider notifications can
      // prove the result before the request returns, and a timed-out request can still settle late.
      return await Promise.race([completion.promise, invocation])
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
    const pending = this.pending.get(sessionId)
    return pending?.interrupted === false && pending.commandTurnId === turnId
  }

  providerTurnId(sessionId: string, turnId: string): string | undefined {
    return this.ownsTurn(sessionId, turnId) ? this.pending.get(sessionId)?.turnId : turnId
  }

  bindClaudeCommand(
    sessionId: string,
    commandTurnId: string,
    providerCommandId: string,
    lifecycleExpected: boolean
  ): void {
    const pending = this.pending.get(sessionId)
    if (!pending || pending.commandTurnId !== commandTurnId || pending.turnId !== undefined) {
      return
    }
    pending.turnId = providerCommandId
    pending.claudeLifecycleExpected = lifecycleExpected
  }

  ended(sessionId: string): void {
    this.pending.get(sessionId)?.finish({ error: 'The provider exited during compaction.' })
  }

  /** Reject the waiter but retain its generation until the provider emits a terminal frame. */
  interrupted(sessionId: string): void {
    this.pending.get(sessionId)?.interrupt()
  }

  /** A provider-acknowledged later turn proves an interrupted command no longer owns output. */
  claudeTurnStarted(sessionId: string, message: Record<string, unknown>): void {
    const pending = this.pending.get(sessionId)
    if (!pending?.interrupted) {
      return
    }
    const envelope = record(message.message)
    const content = Array.isArray(envelope.content) ? envelope.content : [envelope.content]
    const last = content.at(-1)
    const prompt = typeof last === 'string' ? last : record(last).text
    if (
      message.user_message_uuid === pending.turnId ||
      message.uuid === pending.turnId ||
      prompt === '/compact'
    ) {
      return
    }
    pending.finish({ error: 'Compaction was interrupted.' })
  }

  codex(sessionId: string, method: string, value: unknown): void {
    const pending = this.pending.get(sessionId)
    const params = record(value)
    if (!pending || params.threadId !== pending.identity) {
      return
    }
    const turn = record(params.turn)
    // The first start identifies this generation; a later start can belong to work after interrupt.
    if (method === 'turn/started' && pending.turnId === undefined && typeof turn.id === 'string') {
      pending.turnId = turn.id
    }
    if (isCodexCompactionComplete(method, params)) {
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
    if (message.type === 'command_lifecycle') {
      if (message.command_uuid !== pending.turnId) {
        return
      }
      pending.claudeLifecycleObserved = true
      if (message.state === 'cancelled') {
        pending.finish({ error: 'Compaction was interrupted.' })
      } else if (message.state === 'completed') {
        const error =
          pending.error ??
          (pending.compacted ? undefined : 'Compaction was not confirmed by the provider.')
        pending.finish(error ? { error } : {})
      }
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
      // Lifecycle-capable Claude versions identify the exact queued command. Their result frame
      // does not, so wait for the matching command terminal instead of consuming a later turn.
      if (pending.claudeLifecycleExpected || pending.claudeLifecycleObserved) {
        return
      }
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
