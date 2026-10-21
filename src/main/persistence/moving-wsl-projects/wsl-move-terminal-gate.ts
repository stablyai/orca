/**
 * The WSL move's terminal gate (mover design, section 3.2): every pane in scope is either safe to
 * pause and restore on the host, or it blocks the move with the actions that would unblock it.
 * Nothing is ever ended to make progress. Unlike SSH, the local daemon can prove exit, so a pane it
 * cannot answer for is `unverifiable` and blocks rather than being guessed at.
 */
import type { AgentStatusState } from '../../../shared/agent-status-types'
import {
  MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS,
  MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES
} from '../../../shared/orcad-migration/orcad-migration-scrollback'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'

export type WslMovePaneFacts = {
  paneKey: string
  /** The daemon's foreground-process probe, the one the close-tab warning uses. */
  foreground: 'shell-idle' | 'process-running' | 'unverifiable'
  /**
   * The agent in the pane, if any, as the hook server reports it. `ownsForeground` is true only
   * when the foreground process is that agent; a stale row must not vouch for a dev server.
   */
  agent?: { state: AgentStatusState; resumable: boolean; ownsForeground: boolean }
  scrollbackBytes: number
}

export type WslMoveGateInputs = {
  panes: readonly WslMovePaneFacts[]
  /** Automation runs in scope that have not finished. */
  runningAutomationRunIds: readonly string[]
  /** Orchestration dispatches in scope that have not finished. */
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

// Mid-turn or waiting on a person: providers report a pending prompt as 'waiting' or 'blocked'.
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
    // Only an agent that owns the foreground is current; a retained row speaks for nothing.
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
  // A pane listed twice is one snapshot: count its largest reported size once.
  const scrollbackByPane = new Map<string, number>()
  for (const pane of inputs.panes) {
    if (isByteCount(pane.scrollbackBytes) && pane.scrollbackBytes > 0) {
      const bytes = Math.max(scrollbackByPane.get(pane.paneKey) ?? 0, pane.scrollbackBytes)
      scrollbackByPane.set(pane.paneKey, bytes)
    }
  }
  // Over the transfer's caps is a blocker, never a truncation; reported together with any
  // per-pane overage so clearing one pane never uncovers a second blocker.
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
