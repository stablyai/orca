/** How a conversation command the provider ran ended, from the provider's own frames. */
export type StructuredSessionCompactionResult = {
  outcome: 'success' | 'failure' | 'cancellation'
  error?: string
}

type PendingCompaction = {
  identity: string
  /** The host's command turn: its `turnId`, and its journal key. */
  commandTurnId: string
  commandTurnItemId: string
  /** The provider turn that carries the command out, once the provider opened one. */
  turnId?: string
  error?: string
  compacted: boolean
  /** Stop answered the command; the provider's own end only releases the entry. */
  abandoned: boolean
  resolve: (result: StructuredSessionCompactionResult) => void
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

/** A receipt is not completion; keep listening through the provider's terminal frame. There is no
 *  deadline: the command ends by that frame, Stop, or the host's `ended` when the child ends. */
export class StructuredSessionCompaction {
  private readonly pending = new Map<string, PendingCompaction>()

  /** The entry is registered before `invoke` sends anything, so the provider turn it opens is
   *  claimed as the command's. */
  async run(
    sessionId: string,
    identity: string,
    invoke: () => Promise<unknown>,
    command: { turnId: string; turnItemId: string }
  ): Promise<StructuredSessionCompactionResult> {
    if (this.pending.get(sessionId)?.abandoned === false) {
      throw new Error('Compaction is already running.')
    }
    const completion = new Promise<StructuredSessionCompactionResult>((resolve) => {
      this.pending.set(sessionId, {
        identity,
        commandTurnId: command.turnId,
        commandTurnItemId: command.turnItemId,
        compacted: false,
        abandoned: false,
        resolve
      })
    })
    try {
      const admission = record(await invoke())
      if (typeof admission.error === 'string') {
        this.finish(sessionId, { outcome: 'failure', error: admission.error })
      }
    } catch (error) {
      this.pending.delete(sessionId)
      throw error
    }
    return completion
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

  /** The command's journal key when the provider turn starting on `threadId` carries it out. The
   *  single writer of the claim, and idempotent per provider turn so a refused frame's retry gets
   *  the same answer. */
  claimTurn(sessionId: string, threadId: string, providerTurnId: string): string | null {
    const pending = this.pending.get(sessionId)
    if (!pending || pending.identity !== threadId) {
      return null
    }
    pending.turnId ??= providerTurnId
    return pending.turnId === providerTurnId ? pending.commandTurnItemId : null
  }

  /** Stop on the command `commandTurnId` names: it ends as cancelled now, and true says it did. The
   *  entry stays so the interrupt that follows still finds the provider turn, and the provider's end
   *  releases it. A Stop naming an earlier command ends nothing. */
  abandon(sessionId: string, commandTurnId: string): boolean {
    const pending = this.pending.get(sessionId)
    if (!pending || pending.abandoned || pending.commandTurnId !== commandTurnId) {
      return false
    }
    pending.abandoned = true
    pending.resolve({ outcome: 'cancellation' })
    return true
  }

  /** The child ended: drop the entry whatever state it is in, so nothing later is claimed into it. */
  ended(sessionId: string): void {
    this.finish(sessionId, { outcome: 'failure', error: 'The provider exited during compaction.' })
  }

  codex(sessionId: string, method: string, value: unknown): void {
    const pending = this.pending.get(sessionId)
    const params = record(value)
    if (!pending || params.threadId !== pending.identity) {
      return
    }
    if (isCodexCompactionComplete(method, params)) {
      pending.compacted = true
    }
    const turn = record(params.turn)
    if (method === 'turn/completed' && pending.turnId !== undefined && turn.id === pending.turnId) {
      const error = record(turn.error).message
      this.finish(
        sessionId,
        turn.status === 'interrupted'
          ? { outcome: 'cancellation' }
          : turn.status === 'completed' && pending.compacted
            ? { outcome: 'success' }
            : {
                outcome: 'failure',
                error: typeof error === 'string' ? error : 'Compaction did not complete.'
              }
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
      this.finish(sessionId, error ? { outcome: 'failure', error } : { outcome: 'success' })
    }
  }

  private finish(sessionId: string, result: StructuredSessionCompactionResult): void {
    const pending = this.pending.get(sessionId)
    if (!pending) {
      return
    }
    this.pending.delete(sessionId)
    if (!pending.abandoned) {
      pending.resolve(result)
    }
  }
}
