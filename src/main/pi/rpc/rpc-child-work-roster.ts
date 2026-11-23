import type { JsonlRpcRecord } from '../../jsonl-rpc/peer'
import type {
  AgentChildWorkKind,
  AgentChildWorkOutcome
} from '../../../shared/agent-status/child-work/agent-status-child-work'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { normalizeAgentSubagentsField } from '../../../shared/agent-status/contracts/agent-status-subagent-snapshot'
import { PI_NATIVE_CHAT_SUBAGENTS_STATUS_KEY } from '../managed-extensions/agent-status/agent-status-subagent-roster-source'

const OUTCOMES = new Map<unknown, AgentChildWorkOutcome>([
  ['completed', 'succeeded'],
  ['failed', 'failed'],
  ['aborted', 'cancelled']
])

export type PiRpcChildWorkChannel = {
  statusKey: string
  field: string
  kind: AgentChildWorkKind
  idPrefix: string
}

export const PI_RPC_SUBAGENTS_CHANNEL: PiRpcChildWorkChannel = {
  statusKey: PI_NATIVE_CHAT_SUBAGENTS_STATUS_KEY,
  field: 'subagents',
  kind: 'agent',
  idPrefix: ''
}

/** Any extension may list its background commands here; live commands hold the chat in Monitoring. */
export const PI_RPC_BACKGROUND_COMMANDS_CHANNEL: PiRpcChildWorkChannel = {
  statusKey: 'orca-background-commands',
  field: 'commands',
  kind: 'command',
  idPrefix: 'command:'
}

/** Turns one roster status line into child-work edges; a child that leaves the roster has ended. */
export class PiRpcChildWorkRoster {
  private live = new Set<string>()

  constructor(
    private readonly deliver: (evidence: AgentChildWorkEvidence[]) => void,
    private readonly channel: PiRpcChildWorkChannel
  ) {}

  /** Consumes the roster status line before decoration is dropped; false for every other frame. */
  receive(frame: JsonlRpcRecord): boolean {
    if (frame.method !== 'setStatus' || frame.statusKey !== this.channel.statusKey) {
      return false
    }
    let roster: Record<string, unknown> | null
    try {
      roster = JSON.parse(String(frame.statusText))
    } catch {
      return true
    }
    const rows = normalizeAgentSubagentsField(roster?.[this.channel.field]) ?? []
    const ended =
      roster?.ended && typeof roster.ended === 'object'
        ? new Map(Object.entries(roster.ended))
        : null
    const observedAt = Date.now()
    const evidence: AgentChildWorkEvidence[] = rows.map((row) => ({
      type: 'live',
      observedAt,
      child: {
        handle: { idKind: 'task_id', id: this.channel.idPrefix + row.id },
        kind: this.channel.kind,
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
    for (const [id, status] of ended ?? []) {
      if (!next.has(id)) {
        endings.set(id, OUTCOMES.get(status) ?? 'unknown')
      }
    }
    for (const [id, outcome] of endings) {
      evidence.push({
        type: 'ended',
        observedAt,
        handle: { idKind: 'task_id', id: this.channel.idPrefix + id },
        outcome
      })
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
