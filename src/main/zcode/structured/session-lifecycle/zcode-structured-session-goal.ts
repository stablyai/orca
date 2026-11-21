import { throwIfSignalAborted } from '../../../../shared/concurrency/abort-signal-reason'
import type { AgentSessionThreadGoalChange } from '../../../../shared/agent-session/thread-goals/agent-session-thread-goal-wire'
import type { ZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection-types'
import { ZcodeAppServerRequestError } from '../../app-server/zcode-app-server-errors'

// Orca's goal changes onto zcode's single `session/goal` write. A `set` over an existing goal
// uses `replace` (zcode's own rewrite action); pause/resume/clear map one to one.

export async function changeZcodeThreadGoal(input: {
  connection: ZcodeAppServerConnection
  providerSessionId: string
  change: AgentSessionThreadGoalChange
  /** Existing recorded goals require set to create a new objective, never rewrite the old one. */
  replacesGoal: boolean
  timeoutMs: number | null
  signal?: AbortSignal
}): Promise<{ ok: true } | { ok: false; rejected: string }> {
  const action =
    input.change.kind === 'clear'
      ? 'clear'
      : input.change.kind === 'status'
        ? input.change.status === 'active'
          ? 'resume'
          : 'pause'
        : input.replacesGoal
          ? 'replace'
          : 'set'
  try {
    throwIfSignalAborted(input.signal)
    await input.connection.request(
      'session/goal',
      {
        sessionId: input.providerSessionId,
        action,
        ...(input.change.kind === 'set' ? { objective: input.change.objective } : {})
      },
      { timeoutMs: input.timeoutMs, onReply: () => input.signal?.throwIfAborted() }
    )
    return { ok: true }
  } catch (error) {
    if (error instanceof ZcodeAppServerRequestError) {
      return { ok: false, rejected: error.message }
    }
    throw error
  }
}
