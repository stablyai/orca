import { sameAgentStatusSessionOwner } from '../../../shared/agent-status/identity/agent-status-terminal-owner'
import { isSameAgentProcess } from '../../../shared/agent-status/process/agent-process-presence'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'

type ProgressOwner = Pick<
  AgentHookEventPayload,
  'connectionId' | 'worktreeId' | 'agentPresence' | 'providerSession'
> & { agentType: string | undefined }

export type ProducerProgress = {
  lastProducerEventAt: number
  tools: Map<string, { name: string; startedAt: number }>
}

/** Producer observations have a separate clock because status leases and replays renew receivedAt. */
export class ProducerProgressStore {
  private readonly rows = new Map<string, ProducerProgress & { owner: ProgressOwner }>()

  get(paneKey: string): ProducerProgress | undefined {
    return this.rows.get(paneKey)
  }

  clear(): void {
    this.rows.clear()
  }

  delete(paneKey: string): void {
    this.rows.delete(paneKey)
  }

  move(from: string, to: string): void {
    const row = this.rows.get(from)
    this.rows.delete(from)
    if (row) {
      this.rows.set(to, row)
    }
  }

  retireOwner(next: AgentHookEventPayload): void {
    const previous = this.rows.get(next.paneKey)?.owner
    if (
      previous &&
      (!sameAgentStatusSessionOwner(previous, next) ||
        previous.agentType !== next.payload.agentType ||
        (previous.agentPresence?.process &&
          next.agentPresence?.process &&
          !isSameAgentProcess(previous.agentPresence.process, next.agentPresence.process)))
    ) {
      this.delete(next.paneKey)
    }
  }

  observe(event: AgentHookEventPayload, now: number, newOwner = false): void {
    if (event.isReplay || event.providerSessionOnly) {
      return
    }
    this.retireOwner(event)
    let row = newOwner ? undefined : this.rows.get(event.paneKey)
    if (
      !row ||
      (!event.toolAgentId &&
        (event.hookEventName === 'UserPromptSubmit' || event.hookEventName === 'SessionStart'))
    ) {
      row = {
        lastProducerEventAt: now,
        tools: new Map(),
        owner: {
          connectionId: event.connectionId,
          worktreeId: event.worktreeId,
          agentPresence: event.agentPresence,
          providerSession: event.providerSession,
          agentType: event.payload.agentType
        }
      }
      this.rows.set(event.paneKey, row)
    }
    row.owner = {
      connectionId: event.connectionId,
      worktreeId: event.worktreeId ?? row.owner.worktreeId,
      agentPresence: event.agentPresence ?? row.owner.agentPresence,
      providerSession: event.providerSession ?? row.owner.providerSession,
      agentType: event.payload.agentType
    }
    row.lastProducerEventAt = now
    const key = JSON.stringify([event.toolAgentId ?? '', event.toolUseId ?? ''])
    if (event.hookEventName === 'PreToolUse' && event.toolUseId) {
      row.tools.set(
        key,
        row.tools.get(key) ?? { name: event.payload.toolName ?? 'a tool', startedAt: now }
      )
    } else if (
      event.hookEventName === 'PostToolUse' ||
      event.hookEventName === 'PostToolUseFailure'
    ) {
      row.tools.delete(key)
    } else if (event.hookEventName === 'SubagentStop') {
      for (const call of row.tools.keys()) {
        if (JSON.parse(call)[0] === event.toolAgentId) {
          row.tools.delete(call)
        }
      }
    }
    for (const call of event.claudeSettledRequests ?? []) {
      row.tools.delete(JSON.stringify([call.toolAgentId ?? '', call.toolUseId]))
    }
    if (event.payload.state === 'done') {
      row.tools.clear()
    }
  }
}
