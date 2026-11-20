import type { JsonlRpcRecord } from '../../jsonl-rpc/peer'
import type { AgentChildWorkOutcome } from '../../../shared/agent-status/child-work/agent-status-child-work'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { normalizeAgentSubagentsField } from '../../../shared/agent-status/contracts/agent-status-subagent-snapshot'
import { PI_NATIVE_CHAT_SUBAGENTS_STATUS_KEY } from '../managed-extensions/agent-status/agent-status-subagent-roster-source'

const OUTCOMES = new Map<unknown, AgentChildWorkOutcome>([
  ['completed', 'succeeded'],
  ['failed', 'failed'],
  ['aborted', 'cancelled']
])

/** Turns the managed status extension's roster lines into child-work edges; a child that leaves the roster has ended. */
export class PiRpcSubagents {
  private live = new Set<string>()

  constructor(private readonly deliver: (evidence: AgentChildWorkEvidence[]) => void) {}

  /** Consumes the roster status line before decoration is dropped; false for every other frame. */
  receive(frame: JsonlRpcRecord): boolean {
    if (frame.method !== 'setStatus' || frame.statusKey !== PI_NATIVE_CHAT_SUBAGENTS_STATUS_KEY) {
      return false
    }
    let roster: { subagents?: unknown; ended?: unknown }
    try {
      roster = JSON.parse(String(frame.statusText))
    } catch {
      return true
    }
    const rows = normalizeAgentSubagentsField(roster?.subagents) ?? []
    const ended =
      roster?.ended && typeof roster.ended === 'object'
        ? new Map(Object.entries(roster.ended))
        : null
    const observedAt = Date.now()
    const evidence: AgentChildWorkEvidence[] = rows.map((row) => ({
      type: 'live',
      observedAt,
      child: {
        handle: { idKind: 'task_id', id: row.id },
        kind: 'agent',
        residency: 'background',
        state: 'working',
        ...(row.agentType ? { agentType: row.agentType } : {}),
        ...(row.description ? { description: row.description } : {}),
        stoppable: false
      }
    }))
    const next = new Set(rows.map((row) => row.id))
    const endings = new Map<string, AgentChildWorkOutcome>(
      [...this.live].filter((id) => !next.has(id)).map((id) => [id, 'unknown'])
    )
    // A pruned child's own report can follow its unknown ending; the host refines it and ignores ids it never saw.
    // A row that arrives already ended settled in the same snapshot: an awaited call completes between publishes.
    for (const [id, status] of ended ?? []) {
      endings.set(id, OUTCOMES.get(status) ?? 'unknown')
      next.delete(id)
    }
    for (const [id, outcome] of endings) {
      evidence.push({ type: 'ended', observedAt, handle: { idKind: 'task_id', id }, outcome })
    }
    this.live = next
    if (evidence.length > 0) {
      this.deliver(evidence)
    }
    return true
  }

  /** The child exited: children it still listed can no longer report their ending. */
  end(): void {
    if (this.live.size > 0) {
      this.live.clear()
      this.deliver([{ type: 'session-ended', observedAt: Date.now() }])
    }
  }
}
