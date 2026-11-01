import { hasShedSubagentsField } from '../../../shared/agent-hook-relay'
import type { CodexRemoteRosterAuthority } from '../../../shared/agent-hook-listener/providers/codex-state'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'

/** Counts relay links per connection: a restarted guest rebuilds only part of its state, so it cannot vouch for an earlier guest's children. */
export class RelaySessionGenerations {
  private readonly generationByConnectionId = new Map<string, number>()
  /** Links whose guest asked for a pane root; an older guest never asks, nor proves one. */
  private readonly provingPaneRoots = new Set<string>()

  begin(connectionId: string): void {
    const key = connectionId.trim()
    this.generationByConnectionId.set(key, (this.generationByConnectionId.get(key) ?? 0) + 1)
    this.provingPaneRoots.delete(key)
  }

  noteProvesPaneRoots(connectionId: string): void {
    this.provingPaneRoots.add(connectionId.trim())
  }

  provesPaneRoots(connectionId: string): boolean {
    return this.provingPaneRoots.has(connectionId.trim())
  }

  codexRosterAuthority(
    connectionId: string | null,
    payload: ParsedAgentStatusPayload,
    shedFields: unknown
  ): CodexRemoteRosterAuthority | undefined {
    if (payload.agentType !== 'codex') {
      return undefined
    }
    const key = connectionId ?? ''
    return {
      relaySession: `${key}#${this.generationByConnectionId.get(key) ?? 0}`,
      rosterShed: hasShedSubagentsField(shedFields)
    }
  }
}
