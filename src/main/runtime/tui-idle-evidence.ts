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

/** Rank authoritative hooks, blocked tail, strong/quiet readiness, first-party working, then sustained weak readiness.
 * Name-only idle is also emitted mid-turn (#6011); weak verdicts need a rendered-screen poll, and screen vetoes override every ready tier.
 * Derive from retained evidence: graph sync rebuilds leaves and would drop separate provenance fields. */

export type TuiIdleEvidenceRecord = {
  lastAgentStatus: AgentStatus | null
  lastOutputAt: number | null
  lastOscTitle?: string | null
}

export type FirstPartyAgentStatus = {
  state: AgentStatusState
  updatedAt: number
  sessionBoundary?: boolean
  programAtRest?: boolean
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

/** Session boundaries prove a new session awaits input; program OSC 7501 done also proves rest. Ordinary hook done belongs only to the authoritative hook lane. */
export function hasFreshDoneFirstPartyStatus(
  status: FirstPartyAgentStatus,
  staleAfterMs = AGENT_STATUS_STALE_AFTER_MS
): boolean {
  if (
    status?.state !== 'done' ||
    (status.sessionBoundary !== true && status.programAtRest !== true)
  ) {
    return false
  }
  return Date.now() - status.updatedAt <= staleAfterMs
}

/** Tier 2: the agent's own status stream says this turn is still open. */
export function hasFreshWorkingFirstPartyStatus(status: FirstPartyAgentStatus): boolean {
  return isFreshNonDoneAgentStatus(status ?? undefined)
}

/** Rules decide whether name-only titles need quiet corroboration. Agents with explicit hook-ready titles do; name-only rest reporters such as Grok may repaint forever and cannot require quiet. */
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
  // Launch readiness always needs corroboration: shell auto-titles name agents before their TUI can accept input.
  if (!launchReadiness && !nameOnlyIdleNeedsCorroboration(agent, record.lastOscTitle)) {
    // The title is the only rest signal this agent emits, so there is nothing to wait for.
    return true
  }
  // No output clock means no corroboration for name-only titles; await stronger evidence or timeout (#6011).
  return hasQuietOutput(record, quiescenceMs)
}

/** Why a missing clock is not quiet: an adopted or restored pane cannot measure it. */
function hasQuietOutput(record: TuiIdleEvidenceRecord, quiescenceMs: number): boolean {
  return record.lastOutputAt !== null && Date.now() - record.lastOutputAt >= quiescenceMs
}

/** Closed lanes require stronger rest evidence; after-paint lanes require agent output beyond shell echo; open unknown panes may settle without an output clock. */
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
  /** Tier 0: a blocking prompt in the line tail. */
  readTailBlockedReason: () => RuntimeTerminalWaitBlockedReason | null
  /** Renderer-synced pane/tab title, when one exists. */
  rendererTitle?: string | null
  /** Defer multi-KB body scans until the cheaper memoized title check fails. */
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
  /** `recheckAt`: when time alone may settle it, sooner than the next poll sweep. */
  | { kind: 'pending'; quietForeground: QuietForegroundLane; recheckAt?: number }

const READY_STRONG: TuiIdleVerdict = { kind: 'ready-strong' }
const READY_WEAK: TuiIdleVerdict = { kind: 'ready-weak' }
const WORKING: TuiIdleVerdict = { kind: 'working' }

/** Require quiet plus body evidence when titles do not announce rest (Muse/Codex). Scope reads so quoted screens from unrelated agents cannot settle the wait. */
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
  // Both settle at tier 1; prefer memoized title lookup over a multi-KB body scan.
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
  // OMP titles idle before setup opens; require title age and a readable screen clear of the wizard. Output quiet cannot work because paste-mode keepalives repeat each second.
  if (input.agent === 'omp' && isOmpIdleStateTitle(input.record.lastOscTitle)) {
    return input.titleObservedAtEpochMs !== null &&
      Date.now() - input.titleObservedAtEpochMs >= input.quiescenceMs &&
      input.readScreenInputVeto() === false
      ? READY_STRONG
      : { kind: 'pending', quietForeground: 'closed' }
  }
  // First-party working outranks body inference; quiet body can outrank a stale spinner title because live spinners keep emitting output.
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
  // Screen rules veto weak name/process guesses and replace sustained-title inference.
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
