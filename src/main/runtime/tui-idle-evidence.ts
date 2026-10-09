import type { AgentStatus } from '../../shared/agent-detection'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus
} from '../../shared/agent-status-freshness'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import { getSyntheticAgentTerminalTitle } from '../../shared/synthetic-agent-title'
import { resolveExplicitTerminalTitleAgentType } from '../../shared/terminal-title-agent-type'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalAgent } from '../../shared/terminal-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { getTuiAgentRestSignal } from '../../shared/tui-agent-rest-signal'
import { detectExplicitIdleStatusFromTitle } from './terminal-wait-detection'
import { isOmpIdleStateTitle } from './omp-terminal-readiness'
import {
  hasQuietReadyRules,
  idleTitleRequiresQuiet,
  type AgentStateVerdict
} from './agent-state-rules/agent-state-rules-engine'
import { evaluateHookTurn, type TuiIdleHookTurn } from './tui-idle-hook-lane'

/**
 * Ranking the evidence that a `tui-idle` wait may settle on.
 *
 * Why a ranking: a thinking TUI and a finished TUI are both silent, so the absence
 * of a working marker can never prove completion. `detectAgentStatusFromTitle`
 * DEFAULTS a name-only agent title to `idle` — the sidebar needs that to clear a
 * stale spinner (#1437) — so a busy Codex/Devin pane is routinely titled idle, and
 * accepting it satisfied a wait in ~0s mid-turn (#6011).
 *
 *   0. HOOKS — for an agent whose hooks are authoritative (agent-state-rules/ profile), a fresh
 *      hook row for the main agent's turn: done, working, or a permission wait, with the tail's
 *      blocked text judged by the permission arbiter against it (tui-idle-hook-lane.ts).
 *   0b. BLOCKED — otherwise, the rendered screen (or the line tail without a current one) shows a
 *       prompt waiting on the user.
 *   1. STRONG READY — the agent states it is ready: an explicit idle marker in its own
 *      title, or a known ready-prompt body.
 *   1b. QUIET READY SCREEN — Muse titles no rest signal, and agents whose rules
 *      (agent-state-rules/) read a ready screen or text they also paint mid-turn (Codex's
 *      header and composer), so that body is believed only once quiet. OMP's own idle title is
 *      believed once it has stood that long, because it paints that title before its setup
 *      wizard opens.
 *   2. WORKING — a fresh first-party agent status (OSC 9999) saying working/blocked/
 *      waiting, or a working title. The agent's own account of itself outranks anything
 *      inferred.
 *   3. WEAK READY — a name-only title, or a quiet non-shell foreground process. A last
 *      resort, and only once sustained.
 *
 * Why weak ready is a verdict class rather than a per-evidence flag: none of it can see a
 * start-up dialog the line tail lost (Claude's workspace trust), so ONLY the poll may settle
 * on it, after the rendered screen shows no blocker. Synchronous sites settle on tiers 0-1b.
 *
 * Over every ready tier: a screen veto (OMP's setup wizard) refuses input whichever lane settled.
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

export type FirstPartyAgentStatus = {
  state: AgentStatusState
  updatedAt: number
  sessionBoundary?: boolean
} | null

/** Tier 1: an idle marker the agent put in a title itself. */
export function hasExplicitIdleTitle(
  record: TuiIdleEvidenceRecord,
  rendererTitle?: string | null
): boolean {
  // Renderer titles may be display-only decay; native evidence takes precedence.
  const title = record.lastOscTitle ?? rendererTitle
  return Boolean(title && detectExplicitIdleStatusFromTitle(title) === 'idle')
}

/**
 * Tier 1, first-party: a `sessionBoundary` row, which claims a NEW SESSION owns the pane and waits
 * for its first input. Producers set it only for a startup/resume/reset boundary, so it cannot
 * arrive mid-turn (#6011). An ordinary hook `done` decides only through the hook lane (tier 0).
 */
export function hasFreshDoneFirstPartyStatus(
  status: FirstPartyAgentStatus,
  staleAfterMs = AGENT_STATUS_STALE_AFTER_MS
): boolean {
  if (status?.state !== 'done' || status.sessionBoundary !== true) {
    return false
  }
  return Date.now() - status.updatedAt <= staleAfterMs
}

/** Tier 2: the agent's own status stream says this turn is still open. */
export function hasFreshWorkingFirstPartyStatus(status: FirstPartyAgentStatus): boolean {
  return isFreshNonDoneAgentStatus(status ?? undefined)
}

/**
 * Whether a name-only title from `agent` must be corroborated by a quiet stream.
 *
 * An agent's own idle-title rule (agent-state-rules/) answers. Without one, only agents whose
 * hooks drive an explicit `<Agent> ready` title are held to it: for them the bare name is not a
 * rest signal, since a shell auto-title names the agent from the moment it starts, over a
 * start-up dialog or a busy turn alike. Grok, Copilot, Aider, Mimo and agy emit their NAME and
 * nothing more at rest, so holding them to it leaves no settle signal at all: a real idle Grok
 * pane repaints its banner about four times a second forever, so the stream never quiesces and
 * the wait runs to timeout.
 */
export function nameOnlyIdleNeedsCorroboration(
  agent: TuiAgent | null | undefined,
  title?: string | null
): boolean {
  // Why the title fallback: an adopted pane carries no launch metadata, but its
  // name-only title is exactly the thing that names the agent.
  const resolved = agent ?? (title ? resolveExplicitTerminalTitleAgentType(title) : null)
  if (!isTuiAgent(resolved)) {
    return false
  }
  return (
    idleTitleRequiresQuiet(resolved) ?? getSyntheticAgentTerminalTitle(resolved, 'done') !== null
  )
}

/** Tier 3: a title-derived idle, usable only once the stream has also gone quiet. */
export function hasSustainedTitleIdle(
  record: TuiIdleEvidenceRecord,
  agent: TuiAgent | null | undefined,
  quiescenceMs: number,
  launchReadiness = false
): boolean {
  if (record.lastAgentStatus !== 'idle') {
    return false
  }
  // Why launch readiness always corroborates: a shell auto-title (`grok`, `gemini`) names the
  // agent before its TUI mounts, and a paste then lands in a booting TUI or the shell itself.
  if (!launchReadiness && !nameOnlyIdleNeedsCorroboration(agent, record.lastOscTitle)) {
    // The title is the only rest signal this agent emits, so there is nothing to wait for.
    return true
  }
  // Why not "no timestamp means nothing to debounce": an adopted or daemon-backed pane has
  // no local output clock, so for an agent that WILL announce rest explicitly there is no
  // corroboration available at all. Settling here let a busy Codex/Devin satisfy the wait
  // from a name-only title (#6011); hold out for tier 1/2 or the caller's timeout instead.
  return hasQuietOutput(record, quiescenceMs)
}

/** Why a missing clock is not quiet: an adopted or restored pane cannot measure it. */
function hasQuietOutput(record: TuiIdleEvidenceRecord, quiescenceMs: number): boolean {
  return record.lastOutputAt !== null && Date.now() - record.lastOutputAt >= quiescenceMs
}

/**
 * When a quiet non-shell foreground process may settle a pending wait.
 * - `closed`: the agent has a stronger rest signal, so its silence is boot, not rest.
 *   Resolving on it let `dispatch --inject` write into a TUI that had not yet attached
 *   its reader and silently lose the prompt (#9976).
 * - `after-paint`: Orca knows an agent runs here but it has no other rest signal, so this
 *   lane is its only one. A TUI that has painted nothing yet is still booting.
 * - `open`: nothing is known about the pane, so a missing output clock also counts as quiet
 *   (see isQuietForQuiescence).
 */
export type QuietForegroundLane = 'closed' | 'after-paint' | 'open'

export function quietForegroundLaneForTerminalAgent(
  agent: TerminalAgent | null | undefined
): QuietForegroundLane {
  if (!isTuiAgent(agent)) {
    return 'open'
  }
  return getTuiAgentRestSignal(agent) === 'none' ? 'after-paint' : 'closed'
}

export type TuiIdleEvaluationInput = {
  record: TuiIdleEvidenceRecord
  /** Tier 0: a blocking prompt on the rendered screen, or in the line tail without one. */
  readTailBlockedReason: () => RuntimeTerminalWaitBlockedReason | null
  /** Renderer-synced pane/tab title, when one exists. */
  rendererTitle?: string | null
  /** Tier 1 body evidence: a known ready prompt, or an adopted pane's explicit title.
   *  A thunk because producing it means building the pane's wait text and lowercasing it
   *  (~11us and a multi-KB string on a full tail); the title check below usually answers
   *  first, and then none of that has to happen at all. */
  readPositiveBodyEvidence: () => boolean
  /** Tier 1b body evidence: a Muse ready screen, or a rule-file one held to quiet. Thunk, as above. */
  readQuietReadyBodyEvidence: () => boolean
  /** The agent's own rules' answer; any answer shuts the lanes that cannot see its screen. */
  readAgentRuleVerdict: () => AgentStateVerdict | null
  /** Whether an overlay on the agent's screen refuses input; null with no rule or no screen. */
  readScreenInputVeto: () => boolean | null
  /** When the PTY's own current title was observed; null when it has none or no clock. */
  titleObservedAtEpochMs: number | null
  agent: TuiAgent | null | undefined
  firstPartyStatus: FirstPartyAgentStatus
  /** Tier 0: the hook server's fresh row for the pane, read only for an authoritative agent. */
  readHookTurn?: () => TuiIdleHookTurn | null
  quiescenceMs: number
  /** Waiting for a just-launched agent to open its composer, where a name-only title proves
   *  nothing until the stream goes quiet. */
  launchReadiness?: boolean
}

export type TuiIdleVerdict =
  | { kind: 'blocked'; reason: RuntimeTerminalWaitBlockedReason }
  | { kind: 'ready-strong' }
  /** Settles only on the poll, after a rendered-screen read finds no blocker. */
  | { kind: 'ready-weak' }
  /** The agent says it is mid-turn: nothing may settle, and its screen is not read. */
  | { kind: 'working' }
  | { kind: 'pending'; quietForeground: QuietForegroundLane }

const READY_STRONG: TuiIdleVerdict = { kind: 'ready-strong' }
const READY_WEAK: TuiIdleVerdict = { kind: 'ready-weak' }
const WORKING: TuiIdleVerdict = { kind: 'working' }

/**
 * Tier 1b: a ready screen in the body, believed only once the stream has gone quiet.
 *
 * Muse's OSC title is the bare cwd and never changes, and an idle Codex titles its pane with
 * the cwd (plus a thread name) and no agent name, so neither the explicit-idle nor the
 * sustained-title lane can fire. The ready screen proves the TUI is up; the quiescence
 * demand keeps a mid-turn streaming pane from satisfying, mirroring the tier-3 lane's
 * positive-evidence-plus-quiet shape. Scoped to Muse, agents with quiet ready rules, and
 * agent-unknown panes (which read only Muse's screen here): another agent's scrollback quoting
 * them must not settle its wait.
 */
export function hasQuietReadyScreen(
  record: TuiIdleEvidenceRecord,
  agent: TuiAgent | null | undefined,
  readBodyEvidence: () => boolean,
  quiescenceMs: number
): boolean {
  if (agent && agent !== 'muse' && !hasQuietReadyRules(agent)) {
    return false
  }
  // Why: same rule as the tier-3 lane — without an output clock there is no
  // corroboration available, so hold out instead of settling.
  if (!hasQuietOutput(record, quiescenceMs)) {
    return false
  }
  // Why last: a streaming pane never pays for the screen projection.
  return readBodyEvidence()
}

/** The one place the tiers are combined; every settle site branches only on the verdict. */
export function evaluateTuiIdle(input: TuiIdleEvaluationInput): TuiIdleVerdict {
  const verdict = rankTuiIdleEvidence(input)
  // Why over the verdict rather than per lane: an overlay refuses input whichever lane would
  // settle, and only a ready verdict pays for the screen read.
  return isTuiIdleReadyVerdict(verdict) && input.readScreenInputVeto() === true
    ? { kind: 'pending', quietForeground: 'closed' }
    : verdict
}

function rankTuiIdleEvidence(input: TuiIdleEvaluationInput): TuiIdleVerdict {
  const hookVerdict = input.readHookTurn ? evaluateHookTurn(input.agent, input.readHookTurn) : null
  if (hookVerdict) {
    return hookVerdict
  }
  const blockedReason = input.readTailBlockedReason()
  if (blockedReason) {
    return { kind: 'blocked', reason: blockedReason }
  }
  // Qoder publishes "Ready" before its trust dialog is dismissed; only its composer proves input is live.
  if (input.agent === 'qoder' || input.agent === 'qoder-cn') {
    if (
      hasFreshWorkingFirstPartyStatus(input.firstPartyStatus) ||
      input.record.lastAgentStatus === 'working'
    ) {
      return WORKING
    }
    return input.readPositiveBodyEvidence()
      ? READY_STRONG
      : { kind: 'pending', quietForeground: 'closed' }
  }
  // Why the title before the body: both are tier 1, so either settles, but the title is a
  // memoized lookup and the body is a fresh multi-KB scan. Same verdict, cheaper order.
  if (hasExplicitIdleTitle(input.record, input.rendererTitle) || input.readPositiveBodyEvidence()) {
    return READY_STRONG
  }
  // Why beside the title lane, not after the veto: both are tier 1, and a first-party `done`
  // and a fresh `working` cannot both hold — the same row carries one state.
  if (hasFreshDoneFirstPartyStatus(input.firstPartyStatus)) {
    return READY_STRONG
  }
  if (hasFreshWorkingFirstPartyStatus(input.firstPartyStatus)) {
    // Why blocked/waiting stays pending: the agent says it is waiting on the user, which is
    // when a dialog is on screen, so the screen read must still run.
    return input.firstPartyStatus?.state === 'working'
      ? WORKING
      : { kind: 'pending', quietForeground: 'closed' }
  }
  // OMP paints `π >` before the rest of its startup runs and its setup wizard opens, so the title
  // counts only once it has stood a quiescence window on a screen read clear of the wizard. Why
  // title age, not output quiet: OMP re-asserts bracketed paste every second once a terminal
  // answers its probe. Unreadable, the screen cannot rule setup out, and no lane may settle.
  if (input.agent === 'omp' && isOmpIdleStateTitle(input.record.lastOscTitle)) {
    return input.titleObservedAtEpochMs !== null &&
      Date.now() - input.titleObservedAtEpochMs >= input.quiescenceMs &&
      input.readScreenInputVeto() === false
      ? READY_STRONG
      : { kind: 'pending', quietForeground: 'closed' }
  }
  // Why after the veto: a first-party working account outranks inferred body evidence.
  // Why before the working title: Codex can leave a stale spinner title after a turn, and a
  // live spinner emits output every ~100 ms, so a spinning pane is never quiet here.
  if (
    hasQuietReadyScreen(
      input.record,
      input.agent,
      input.readQuietReadyBodyEvidence,
      input.quiescenceMs
    )
  ) {
    return READY_STRONG
  }
  if (input.record.lastAgentStatus === 'working') {
    return WORKING
  }
  // Why here: a name-only title and a quiet process cannot see the picker or prompt the screen
  // refused, and an agent's own idle-title rule replaces the sustained-title lane below.
  const ruled = input.readAgentRuleVerdict()
  if (ruled !== null) {
    return isSettledWeakIdle(ruled, input.record, input.quiescenceMs, input.launchReadiness)
      ? READY_WEAK
      : { kind: 'pending', quietForeground: 'closed' }
  }
  if (hasSustainedTitleIdle(input.record, input.agent, input.quiescenceMs, input.launchReadiness)) {
    return READY_WEAK
  }
  return {
    kind: 'pending',
    quietForeground:
      input.record.lastAgentStatus === null
        ? quietForegroundLaneForTerminalAgent(input.agent)
        : 'closed'
  }
}

// Why launch readiness asks quiet of every weak idle: those rules read a name-only title, which a
// shell auto-title writes before the TUI mounts, as in the sustained-title lane.
function isSettledWeakIdle(
  verdict: AgentStateVerdict,
  record: TuiIdleEvidenceRecord,
  quiescenceMs: number,
  launchReadiness = false
): boolean {
  return (
    verdict.state === 'idle' &&
    verdict.strength === 'weak' &&
    ((!verdict.requiresQuiet && !launchReadiness) || hasQuietOutput(record, quiescenceMs))
  )
}

export function isTuiIdleReadyVerdict(verdict: TuiIdleVerdict): boolean {
  return verdict.kind === 'ready-strong' || verdict.kind === 'ready-weak'
}

/**
 * Tier 0b over the current rendered screen. The tail arbiter's stamp-vs-clear ordering judges
 * whether HISTORY is stale; screen text is present now, so only strong evidence clears it.
 */
export function judgeScreenBlockedText(input: {
  reason: RuntimeTerminalWaitBlockedReason | null
  record: TuiIdleEvidenceRecord
  rendererTitle?: string | null
  firstPartyStatus: FirstPartyAgentStatus
  explicitStatus: { status: AgentStatus; updatedAt: number } | null
  /** When the tail scan stamped this pane's blocker; null when the tail never saw one. */
  blockedAt: number | null
}): RuntimeTerminalWaitBlockedReason | null {
  const { reason, explicitStatus } = input
  // Why exempt: the arbiter lets no title clear an approval menu, which Cursor paints under its
  // working spinner.
  if (reason === null || reason === 'agent-approval-prompt') {
    return reason
  }
  // Why the working gate, as the poll's screen read: a mid-turn agent's output can quote a dialog.
  if (
    input.record.lastAgentStatus === 'working' ||
    (hasFreshWorkingFirstPartyStatus(input.firstPartyStatus) &&
      input.firstPartyStatus?.state === 'working') ||
    hasFreshDoneFirstPartyStatus(input.firstPartyStatus) ||
    hasExplicitIdleTitle(input.record, input.rendererTitle)
  ) {
    return null
  }
  if (explicitStatus === null || explicitStatus.status === 'permission') {
    return reason
  }
  // Why only a done newer than the blocker: a menu painted after the turn ended is still open.
  return explicitStatus.status === 'working' ||
    (input.blockedAt !== null && explicitStatus.updatedAt > input.blockedAt)
    ? null
    : reason
}
