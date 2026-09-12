import type { AgentStatus } from '../../shared/agent-detection'
import { isFreshNonDoneAgentStatus } from '../../shared/agent-status-freshness'
import type { AgentStatusState } from '../../shared/agent-status-types'
import { getSyntheticAgentTerminalTitle } from '../../shared/synthetic-agent-title'
import { resolveExplicitTerminalTitleAgentType } from '../../shared/terminal-title-agent-type'
import type { TuiAgent } from '../../shared/tui-agent'
import { detectExplicitIdleStatusFromTitle } from './terminal-wait-detection'

/**
 * Ranking the evidence that a `tui-idle` wait may settle on.
 *
 * Why a ranking: a thinking TUI and a finished TUI are both silent, so the absence
 * of a working marker can never prove completion. `detectAgentStatusFromTitle`
 * DEFAULTS a name-only agent title to `idle` — the sidebar needs that to clear a
 * stale spinner (#1437) — so a busy Codex/Devin pane is routinely titled idle, and
 * accepting it satisfied a wait in ~0s mid-turn (#6011).
 *
 *   1. POSITIVE — the agent states it is ready: an explicit idle marker in its own
 *      title, or a known ready-prompt body.
 *   2. VETO — a fresh first-party agent status (OSC 9999) saying working/blocked/
 *      waiting. The agent's own account of itself outranks anything inferred.
 *   3. ABSENCE — a name-only title, or a quiet non-shell foreground process. A last
 *      resort, and only once sustained.
 *
 * Why derived here rather than stamped onto the record at write time: `syncWindowGraph`
 * rebuilds every leaf from an explicit field list, so a bespoke provenance field is
 * silently dropped on any renderer publish and the verdict silently flips. `lastOscTitle`
 * is copied, so reading the rank back off it cannot decay.
 */

export type TuiIdleEvidenceRecord = {
  lastAgentStatus: AgentStatus | null
  lastOutputAt: number | null
  lastOscTitle?: string | null
}

export type FirstPartyAgentStatus = { state: AgentStatusState; updatedAt: number } | null

/** Tier 1: an idle marker the agent put in a title itself. */
export function hasExplicitIdleTitle(
  record: TuiIdleEvidenceRecord,
  rendererTitle?: string | null
): boolean {
  // Why lastOscTitle too, not just the renderer's pane title: a daemon-hosted or
  // background pane has no renderer publishing a title, so reading only the synced
  // one dropped an explicit `Codex ready` to the tier-3 lane and delayed it by the
  // whole quiescence window.
  for (const title of [rendererTitle, record.lastOscTitle]) {
    if (title && detectExplicitIdleStatusFromTitle(title) === 'idle') {
      return true
    }
  }
  return false
}

/** Tier 2: the agent's own status stream says this turn is still open. */
export function hasFreshWorkingFirstPartyStatus(status: FirstPartyAgentStatus): boolean {
  return isFreshNonDoneAgentStatus(status ?? undefined)
}

/**
 * Whether a name-only title from `agent` may be held to the tier-3 quiescence demand.
 *
 * Only for agents that go on to announce rest with an explicit title of their own (the
 * hook-driven `Codex ready` / `Devin ready`). Grok, Copilot, Aider, Mimo, agy and
 * OpenCode emit their NAME and nothing more at rest, so holding them to it leaves no
 * settle signal at all: a real idle Grok pane repaints its banner about four times a
 * second forever, so the stream never quiesces and the wait runs to timeout.
 */
export function nameOnlyIdleNeedsCorroboration(
  agent: TuiAgent | null | undefined,
  title?: string | null
): boolean {
  // Why the title fallback: an adopted pane carries no launch metadata, but its
  // name-only title is exactly the thing that names the agent.
  const resolved = agent ?? (title ? resolveExplicitTerminalTitleAgentType(title) : null)
  return getSyntheticAgentTerminalTitle(resolved, 'done') !== null
}

/** Tier 3: a title-derived idle, usable only once the stream has also gone quiet. */
export function hasSustainedTitleIdle(
  record: TuiIdleEvidenceRecord,
  agent: TuiAgent | null | undefined,
  quiescenceMs: number
): boolean {
  if (record.lastAgentStatus !== 'idle') {
    return false
  }
  // Handles with no PTY output of their own (adopted/daemon) have nothing to debounce.
  if (record.lastOutputAt === null) {
    return true
  }
  if (!nameOnlyIdleNeedsCorroboration(agent, record.lastOscTitle)) {
    return true
  }
  return Date.now() - record.lastOutputAt >= quiescenceMs
}

/**
 * Tier 3, cold start: Orca launched a known agent on this PTY, so a quiet non-shell
 * foreground process is an agent still booting, not one sitting at its prompt. Resolving
 * on it is what let `dispatch --inject` write into a TUI that had not yet attached its
 * reader and silently lose the prompt (#9976).
 */
export function quietForegroundProcessProvesTuiIdle(agent: TuiAgent | null | undefined): boolean {
  return !agent
}

export type TuiIdleSatisfactionInput = {
  record: TuiIdleEvidenceRecord
  /** Renderer-synced pane/tab title, when one exists. */
  rendererTitle?: string | null
  /** Tier 1 body evidence: a known ready prompt, or an adopted pane's explicit title. */
  positiveBodyEvidence: boolean
  agent: TuiAgent | null | undefined
  firstPartyStatus: FirstPartyAgentStatus
  quiescenceMs: number
}

/** The one place the three tiers are combined; every satisfaction site routes here. */
export function isTuiIdleSatisfied(input: TuiIdleSatisfactionInput): boolean {
  if (input.positiveBodyEvidence || hasExplicitIdleTitle(input.record, input.rendererTitle)) {
    return true
  }
  if (hasFreshWorkingFirstPartyStatus(input.firstPartyStatus)) {
    return false
  }
  return hasSustainedTitleIdle(input.record, input.agent, input.quiescenceMs)
}
