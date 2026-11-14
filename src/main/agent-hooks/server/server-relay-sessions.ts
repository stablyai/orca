import { hasShedSubagentsField } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { readAgentPaneRootBinding } from '../../../shared/agent-status/process/agent-process-presence'
import type { CodexRemoteRosterAuthority } from '../../../shared/agent-hook-listener/providers/codex/codex-state'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'

// One binding per pane a relay asked about; a link restart drops them all.
const MAX_PANE_ROOT_BINDINGS = 512

type PaneRootBinding = { binding: string; isCurrent: () => boolean }

/** Counts relay links per connection: a restarted guest rebuilds only part of its state, so it cannot vouch for an earlier guest's children. */
export class RelaySessionGenerations {
  private readonly generationByConnectionId = new Map<string, number>()
  /** The pane-root binding issued to each link per pane: the only proof its owners may echo. */
  private readonly paneRootsByConnectionId = new Map<string, Map<string, PaneRootBinding>>()

  begin(connectionId: string): void {
    const key = connectionId.trim()
    this.generationByConnectionId.set(key, this.generation(key) + 1)
    this.paneRootsByConnectionId.delete(key)
  }

  generation(connectionId: string): number {
    return this.generationByConnectionId.get(connectionId.trim()) ?? 0
  }

  /** Bind a root the desktop returned to the link that asked, if that link is still current. */
  issuePaneRoot(
    connectionId: string,
    generation: number,
    paneKey: string,
    incarnation: string,
    isCurrent: () => boolean
  ): string | undefined {
    const key = connectionId.trim()
    if (this.generation(key) !== generation || !isCurrent()) {
      return undefined
    }
    const binding = `${generation}/${incarnation}`
    const panes = this.paneRootsByConnectionId.get(key) ?? new Map<string, PaneRootBinding>()
    panes.delete(paneKey)
    panes.set(paneKey, { binding, isCurrent })
    for (const oldest of panes.keys()) {
      if (panes.size <= MAX_PANE_ROOT_BINDINGS) {
        break
      }
      panes.delete(oldest)
    }
    this.paneRootsByConnectionId.set(key, panes)
    return binding
  }

  /** Root proof for a relayed owner: it echoes this link's current binding for the pane, whose
   *  PTY still runs there. */
  rootProof(connectionId: string | null, paneKey: string, presence: unknown): { rooted?: true } {
    const binding = readAgentPaneRootBinding(presence)
    const issued =
      connectionId && binding
        ? this.paneRootsByConnectionId.get(connectionId.trim())?.get(paneKey)
        : undefined
    return issued && issued.binding === binding && issued.isCurrent() ? { rooted: true } : {}
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
