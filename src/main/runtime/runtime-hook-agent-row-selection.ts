import {
  AGENT_STATUS_STALE_AFTER_MS,
  pickParsedAgentStatusPayload,
  type AgentStatusEntry,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'
import { mapExplicitAgentStateToRuntimeTerminalStatus } from './runtime-worktree-status-projection'

/** One hook-server row projected into the shape the runtime's own readers consume. */
export type RuntimeAgentRowSnapshot = {
  paneKey: string
  worktreeId?: string
  tabId?: string
  connectionId: string | null
  payload: ParsedAgentStatusPayload
  stateStartedAt: number
  updatedAt: number
  evidenceObservedAt?: number
  providerSession?: AgentProviderSessionMetadata
}

function isLiveObservation(row: AgentStatusIpcPayload): boolean {
  // A restored row cannot prove liveness (the turn may have ended while offline), and a
  // resume-identity row carries no status at all.
  return row.restoredUnconfirmed !== true && row.providerSessionOnly !== true
}

type HookRowJoin = {
  handles: Iterable<string>
  paneKeys: Iterable<string>
  hookRows: readonly AgentStatusIpcPayload[]
}

function isPermissionState(state: AgentStatusEntry['state']): boolean {
  return mapExplicitAgentStateToRuntimeTerminalStatus(state) === 'permission'
}

/** The freshest live hook row for a terminal, joined on any of its handles or pane keys. */
export function selectFreshExplicitAgentStatusRow(args: HookRowJoin): AgentStatusIpcPayload | null {
  const now = Date.now()
  const handles = new Set(args.handles)
  const paneKeys = new Set(args.paneKeys)
  let best: AgentStatusIpcPayload | null = null
  for (const row of args.hookRows) {
    if (!(row.terminalHandle && handles.has(row.terminalHandle)) && !paneKeys.has(row.paneKey)) {
      continue
    }
    if (!row.state || !isLiveObservation(row) || typeof row.receivedAt !== 'number') {
      continue
    }
    if (now - (row.evidenceObservedAt ?? row.receivedAt) > AGENT_STATUS_STALE_AFTER_MS) {
      continue
    }
    if (
      !best ||
      row.receivedAt > best.receivedAt ||
      (row.receivedAt === best.receivedAt && isPermissionState(row.state))
    ) {
      best = row
    }
  }
  return best
}

/** The freshest explicit state for a terminal, matched on its handle or its pane key. */
export function selectFreshExplicitAgentStatus(args: {
  handle: string
  paneKey: string | null
  hookRows: readonly AgentStatusIpcPayload[]
}): {
  status: NonNullable<RuntimeTerminalAgentStatus['status']>
  updatedAt: number
  stateStartedAt: number
  explicitPromptStartedAt: number | null
} | null {
  const row = selectFreshExplicitAgentStatusRow({
    handles: [args.handle],
    paneKeys: args.paneKey ? [args.paneKey] : [],
    hookRows: args.hookRows
  })
  return row
    ? {
        status: mapExplicitAgentStateToRuntimeTerminalStatus(row.state),
        updatedAt: row.receivedAt,
        stateStartedAt: typeof row.stateStartedAt === 'number' ? row.stateStartedAt : row.receivedAt,
        explicitPromptStartedAt: row.explicitPromptStartedAt ?? null
      }
    : null
}

/** The pane's live row for the mobile projection: its own key first, then the terminal it is
 *  bound to, which is the only join left once a pane key has moved. */
export function selectFreshAgentRowForMobileTab(args: {
  paneKey: string
  terminalHandle: string | null
  hookRows: readonly AgentStatusIpcPayload[]
}): RuntimeAgentRowSnapshot | null {
  let match: AgentStatusIpcPayload | null = null
  const now = Date.now()
  for (const row of args.hookRows) {
    if (
      !isLiveObservation(row) ||
      now - (row.evidenceObservedAt ?? row.receivedAt) > AGENT_STATUS_STALE_AFTER_MS
    ) {
      continue
    }
    if (row.paneKey === args.paneKey) {
      if (!match || match.paneKey !== args.paneKey || row.receivedAt > match.receivedAt) {
        match = row
      }
      continue
    }
    if (
      match?.paneKey !== args.paneKey &&
      args.terminalHandle !== null &&
      row.terminalHandle === args.terminalHandle &&
      (!match || row.receivedAt > match.receivedAt)
    ) {
      match = row
    }
  }
  if (!match) {
    return null
  }
  return {
    paneKey: match.paneKey,
    connectionId: match.connectionId ?? null,
    ...(match.worktreeId ? { worktreeId: match.worktreeId } : {}),
    ...(match.tabId ? { tabId: match.tabId } : {}),
    payload: pickParsedAgentStatusPayload(match),
    stateStartedAt: match.stateStartedAt ?? match.receivedAt,
    updatedAt: match.receivedAt,
    ...(match.providerSession ? { providerSession: match.providerSession } : {}),
    ...(match.evidenceObservedAt !== undefined
      ? { evidenceObservedAt: match.evidenceObservedAt }
      : {})
  }
}
