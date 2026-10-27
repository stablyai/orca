// Never end work automatically; missing daemon evidence blocks rather than guessing a pane is restorable.
import type { AgentStatusState } from '../../../shared/agent-status-types'
import {
  MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS,
  MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES
} from '../../../shared/orcad-migration/orcad-migration-scrollback'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'

export type WslMovePaneFacts = {
  paneKey: string
  /** Same foreground probe as close-tab warnings. */
  foreground: 'shell-idle' | 'process-running' | 'unverifiable'
  /** Only foreground ownership lets a current agent row vouch for the process. */
  agent?: { state: AgentStatusState; resumable: boolean; ownsForeground: boolean }
  scrollbackBytes: number
}

export type WslMoveGateInputs = {
  panes: readonly WslMovePaneFacts[]
  runningAutomationRunIds: readonly string[]
  activeDispatchIds: readonly string[]
}

export type WslMoveGateAction = 'wait' | 'end' | 'skip-project' | 'clear-scrollback'

export type WslMoveGateBlocker = {
  kind:
    | 'agent-working'
    | 'process-running'
    | 'agent-not-resumable'
    | 'unverifiable'
    | 'automation-running'
    | 'dispatch-running'
    | 'scrollback-too-large'
  ids: string[]
  actions: WslMoveGateAction[]
}

export type WslMoveGateVerdict =
  | { verdict: 'ready'; paneKeys: string[] }
  | { verdict: 'blocked'; blockers: WslMoveGateBlocker[] }

// Waiting and blocked both include agents awaiting human input.
const AGENT_BUSY_STATES: ReadonlySet<AgentStatusState> = new Set(['working', 'waiting', 'blocked'])

export function assessWslMoveTerminals(inputs: WslMoveGateInputs): WslMoveGateVerdict {
  const blockers = new Map<WslMoveGateBlocker['kind'], WslMoveGateBlocker>()
  const block = (kind: WslMoveGateBlocker['kind'], id: string, actions: WslMoveGateAction[]) => {
    const existing = blockers.get(kind)
    if (!existing) {
      blockers.set(kind, { kind, ids: [id], actions })
    } else if (!existing.ids.includes(id)) {
      existing.ids.push(id)
    }
  }
  for (const pane of inputs.panes) {
    // Retained agent rows cannot vouch for another foreground process.
    const agent = pane.agent?.ownsForeground ? pane.agent : undefined
    const hasByteCount = isByteCount(pane.scrollbackBytes)
    if (pane.foreground === 'unverifiable' || !hasByteCount) {
      block('unverifiable', pane.paneKey, ['wait', 'skip-project'])
    } else if (agent && AGENT_BUSY_STATES.has(agent.state)) {
      block('agent-working', pane.paneKey, ['wait', 'end', 'skip-project'])
    } else if (agent && !agent.resumable) {
      block('agent-not-resumable', pane.paneKey, ['end', 'skip-project'])
    } else if (pane.foreground === 'process-running' && !agent) {
      block('process-running', pane.paneKey, ['end', 'skip-project'])
    }
    if (hasByteCount && pane.scrollbackBytes > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT) {
      block('scrollback-too-large', pane.paneKey, ['clear-scrollback'])
    }
  }
  for (const id of inputs.runningAutomationRunIds) {
    block('automation-running', id, ['wait', 'skip-project'])
  }
  for (const id of inputs.activeDispatchIds) {
    block('dispatch-running', id, ['wait', 'skip-project'])
  }
  // Duplicate panes contribute their maximum size once.
  const scrollbackByPane = new Map<string, number>()
  for (const pane of inputs.panes) {
    if (isByteCount(pane.scrollbackBytes) && pane.scrollbackBytes > 0) {
      const bytes = Math.max(scrollbackByPane.get(pane.paneKey) ?? 0, pane.scrollbackBytes)
      scrollbackByPane.set(pane.paneKey, bytes)
    }
  }
  // Report all cap violations together so clearing one pane cannot reveal another hidden blocker.
  const total = [...scrollbackByPane.values()].reduce((sum, bytes) => sum + bytes, 0)
  if (
    total > MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES ||
    scrollbackByPane.size > MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS
  ) {
    for (const paneKey of scrollbackByPane.keys()) {
      block('scrollback-too-large', paneKey, ['clear-scrollback'])
    }
  }
  return blockers.size > 0
    ? { verdict: 'blocked', blockers: [...blockers.values()] }
    : { verdict: 'ready', paneKeys: [...new Set(inputs.panes.map((pane) => pane.paneKey))] }
}

function isByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
