import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { mapExplicitAgentStateToRuntimeTerminalStatus } from './runtime-worktree-status-projection'
import type { RuntimeAgentRowSnapshot } from './runtime-worktree-agent-rows'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export class RuntimeAgentRowStore {
  private readonly byPaneKey = new Map<string, RuntimeAgentRowSnapshot>()

  values(): IterableIterator<RuntimeAgentRowSnapshot> {
    return this.byPaneKey.values()
  }

  retain(args: {
    ptyId: string
    paneKey: string
    worktreeId?: string
    tabId?: string
    connectionId: string | null
    payload: ParsedAgentStatusPayload
  }): boolean {
    const now = Date.now()
    const previous = this.byPaneKey.get(args.paneKey)
    const stateStartedAt =
      previous?.payload.state === args.payload.state ? previous.stateStartedAt : now
    this.byPaneKey.set(args.paneKey, { ...args, stateStartedAt, updatedAt: now })
    return (
      !previous ||
      previous.payload.state !== args.payload.state ||
      previous.payload.workingMode !== args.payload.workingMode ||
      previous.payload.prompt !== args.payload.prompt ||
      (previous.payload.agentType ?? null) !== (args.payload.agentType ?? null) ||
      (previous.payload.toolName ?? null) !== (args.payload.toolName ?? null) ||
      (previous.payload.interactivePrompt ?? null) !== (args.payload.interactivePrompt ?? null) ||
      (previous.payload.interrupted ?? false) !== (args.payload.interrupted ?? false) ||
      (previous.payload.turnCompletedAt ?? null) !== (args.payload.turnCompletedAt ?? null) ||
      (previous.payload.lastAssistantMessage ?? null) !==
        (args.payload.lastAssistantMessage ?? null)
    )
  }

  clearPty(ptyId: string): void {
    for (const [paneKey, snapshot] of this.byPaneKey) {
      if (snapshot.ptyId === ptyId) {
        this.byPaneKey.delete(paneKey)
      }
    }
  }

  getFreshForMobile(
    paneKey: string,
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab
  ): RuntimeAgentRowSnapshot | null {
    let retained = this.byPaneKey.get(paneKey) ?? null
    if (!retained) {
      const ptyId = pty?.ptyId ?? tab.ptyId ?? null
      if (ptyId) {
        for (const snapshot of this.byPaneKey.values()) {
          if (snapshot.ptyId === ptyId && (!retained || snapshot.updatedAt > retained.updatedAt)) {
            retained = snapshot
          }
        }
      }
    }
    return retained && Date.now() - retained.updatedAt <= AGENT_STATUS_STALE_AFTER_MS
      ? retained
      : null
  }

  getFreshExplicit(args: {
    handle: string
    paneKey: string | null
    hookRows: readonly AgentStatusIpcPayload[]
  }): {
    status: NonNullable<RuntimeTerminalAgentStatus['status']>
    updatedAt: number
    stateStartedAt: number
  } | null {
    const now = Date.now()
    let bestStatus: NonNullable<RuntimeTerminalAgentStatus['status']> | null = null
    let bestUpdatedAt = -1
    let bestStateStartedAt = -1
    const consider = (
      state: AgentStatusEntry['state'] | undefined,
      updatedAt: number | null | undefined,
      restoredUnconfirmed = false,
      stateStartedAt?: number | null
    ): void => {
      if (!state || restoredUnconfirmed || typeof updatedAt !== 'number') {
        return
      }
      if (now - updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
        return
      }
      const status = mapExplicitAgentStateToRuntimeTerminalStatus(state)
      if (updatedAt > bestUpdatedAt || (updatedAt === bestUpdatedAt && status === 'permission')) {
        bestStatus = status
        bestUpdatedAt = updatedAt
        bestStateStartedAt = typeof stateStartedAt === 'number' ? stateStartedAt : updatedAt
      }
    }
    if (args.paneKey) {
      const retained = this.byPaneKey.get(args.paneKey)
      consider(retained?.payload.state, retained?.updatedAt, false, retained?.stateStartedAt)
    }
    for (const row of args.hookRows) {
      if (row.terminalHandle !== args.handle && (!args.paneKey || row.paneKey !== args.paneKey)) {
        continue
      }
      consider(row.state, row.receivedAt, row.restoredUnconfirmed, row.stateStartedAt)
    }
    return bestStatus
      ? { status: bestStatus, updatedAt: bestUpdatedAt, stateStartedAt: bestStateStartedAt }
      : null
  }
}
