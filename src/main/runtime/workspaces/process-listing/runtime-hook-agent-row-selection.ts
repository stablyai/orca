import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import {
  pickHostTurnEnd,
  pickParsedAgentStatusPayload,
  type AgentStatusEntry,
  type ParsedAgentStatusPayload,
  type TurnEndDisposition
} from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ProgramStatusFacet } from '../../../../shared/program-status/facet'
import type { RuntimeTerminalAgentStatus } from '../../../../shared/runtime-terminal-contracts'
import { mapExplicitAgentStateToRuntimeTerminalStatus } from './runtime-worktree-status-projection'
import { mainAgentState } from '../../../../shared/agent-status/lifecycle/main-agent-status'

/** One hook-server row projected into the shape the runtime's own readers consume. */
export type RuntimeAgentRowSnapshot = {
  paneKey: string
  worktreeId?: string
  tabId?: string
  connectionId: string | null
  payload: ParsedAgentStatusPayload
  stateStartedAt: number
  turnEndedAt?: number
  turnEndDisposition?: TurnEndDisposition
  updatedAt: number
  evidenceObservedAt?: number
  providerSession?: AgentProviderSessionMetadata
  programStatus?: ProgramStatusFacet
}

function isLiveObservation(row: AgentStatusIpcPayload): boolean {
  // Restored rows cannot prove current liveness; resume-identity rows carry no status.
  return row.restoredUnconfirmed !== true && row.providerSessionOnly !== true
}

type HookRowJoin = {
  handles: Iterable<string>
  paneKeys: Iterable<string>
  hookRows: readonly AgentStatusIpcPayload[]
  /** Lets a restored permission wait stand while the pane's screen could still show its dialog. */
  screenMayHoldDialog?: () => boolean
}

function isPermissionState(state: AgentStatusEntry['state']): boolean {
  return mapExplicitAgentStateToRuntimeTerminalStatus(state) === 'permission'
}

// No input reaches a pane while its runtime is down, so a dialog open at shutdown is still open (#35962).
function isHeldRestoredPermission(row: AgentStatusIpcPayload, join: HookRowJoin): boolean {
  return (
    row.restoredUnconfirmed === true &&
    row.providerSessionOnly !== true &&
    isPermissionState(row.state) &&
    join.screenMayHoldDialog?.() === true
  )
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
    if (
      !row.state ||
      typeof row.receivedAt !== 'number' ||
      now - (row.evidenceObservedAt ?? row.receivedAt) > AGENT_STATUS_STALE_AFTER_MS ||
      !(isLiveObservation(row) || isHeldRestoredPermission(row, args))
    ) {
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
  screenMayHoldDialog?: () => boolean
}): {
  status: NonNullable<RuntimeTerminalAgentStatus['status']>
  updatedAt: number
  stateStartedAt: number
  /** When the main agent's own turn began; null while it rests, even if child work keeps the row working. */
  mainAgentWorkingStartedAt: number | null
} | null {
  const row = selectFreshExplicitAgentStatusRow({
    handles: [args.handle],
    paneKeys: args.paneKey ? [args.paneKey] : [],
    hookRows: args.hookRows,
    screenMayHoldDialog: args.screenMayHoldDialog
  })
  if (!row) {
    return null
  }
  const stateStartedAt =
    typeof row.stateStartedAt === 'number' ? row.stateStartedAt : row.receivedAt
  return {
    status: mapExplicitAgentStateToRuntimeTerminalStatus(row.state),
    updatedAt: row.receivedAt,
    stateStartedAt,
    mainAgentWorkingStartedAt:
      mainAgentState(row) === 'working' ? (row.mainAgent?.stateStartedAt ?? stateStartedAt) : null
  }
}

/** Prefer the pane's own key, then its terminal binding when the pane key has moved. */
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
    ...pickHostTurnEnd(match),
    updatedAt: match.receivedAt,
    ...(match.providerSession ? { providerSession: match.providerSession } : {}),
    ...(match.programStatus ? { programStatus: match.programStatus } : {}),
    ...(match.evidenceObservedAt !== undefined
      ? { evidenceObservedAt: match.evidenceObservedAt }
      : {})
  }
}
