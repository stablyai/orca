import {
  ClaudeSessionContinuationTracker,
  resolvePaneClaudeContinuation
} from '../shared/agent-hook-listener/claude-session-continuation'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'

export class RelayAgentPresence {
  private readonly pending = new WeakMap<AgentHookEventPayload, Promise<void>>()
  private readonly claudeContinuations = new ClaudeSessionContinuationTracker()

  constructor(private readonly state: Pick<HookListenerState, 'lastStatusByPaneKey'>) {}

  check(
    row: AgentHookEventPayload | undefined,
    current: () => AgentHookEventPayload | undefined,
    publish: (event: AgentHookEventPayload) => void
  ): Promise<void> {
    if (row) {
      this.followClaudeSessionContinuation(row, publish)
    }
    // Why re-read: a rebinding above replaced the cached row the probe must compare against.
    const owner = row ? current() : undefined
    if (!owner?.agentPresence?.process || owner.agentPresence.ended) {
      return Promise.resolve()
    }
    const existing = this.pending.get(owner)
    if (existing) {
      return existing
    }
    const presence = owner.agentPresence
    const check = probeAgentProcessPresence(presence.process)
      .then((verdict) => {
        if (verdict === 'exited' && current() === owner) {
          publish({
            ...owner,
            isReplay: undefined,
            hookEventName: 'AgentProcessExit',
            agentPresence: { ...presence, ended: true }
          })
        }
      })
      .finally(() => this.pending.delete(owner))
    this.pending.set(owner, check)
    return check
  }

  /** Same rebinding as the client's hook server (#24117); the relay owns this host's transcripts. */
  private followClaudeSessionContinuation(
    row: AgentHookEventPayload,
    publish: (event: AgentHookEventPayload) => void
  ): void {
    const next = resolvePaneClaudeContinuation(
      this.claudeContinuations,
      this.state.lastStatusByPaneKey,
      row.paneKey
    )
    if (next) {
      publish({
        ...row,
        providerSession: next,
        isReplay: true,
        hookEventName: undefined,
        hasExplicitPrompt: undefined
      })
    }
  }
}
