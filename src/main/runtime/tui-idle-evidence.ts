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
import { getTuiAgentRestSignal } from '../../shared/tui-agent-rest-signal'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  detectExplicitIdleStatusFromTitle,
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isQuietReadyScreenBody
} from './terminal-wait-detection'
import {
  evaluateAgentStateRules,
  hasQuietReadyRules,
  idleTitleRequiresQuiet,
  readsTrustedScreen,
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
 *   0b. BLOCKED — otherwise, the tail shows a prompt waiting on the user.
 *   1. STRONG READY — the agent states it is ready: an explicit idle marker in its own
 *      title, or a known ready-prompt body.
 *   1b. QUIET READY SCREEN — Muse titles no rest signal, and agents whose rules
 *      (agent-state-rules/) read a ready screen or text they also paint mid-turn (Codex's
 *      header and composer), so that body is believed only once quiet.
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

/**
 * Tier 1, first-party: the agent's own hook says the turn ENDED.
 *
 * Why DSH needs its own lane: the other tiers all read the title, and DSH cannot carry idle
 * there. Its rest prefix is `✦`, which is Gemini's WORKING glyph, so the title detector
 * deliberately reports no status for a DSH pane at all (see agent-title-status.ts) — which
 * left `tui-idle` with nothing to settle on, and a supervised worker waiting on a ready
 * composer until its timeout.
 *
 * Why a hook `done` is trustworthy here where a title would not be: it is the agent's own
 * account of its own turn, and `normalizeDshEvent` drops SubagentStart/SubagentStop, so a
 * `done` row for a DSH pane is the LEAD's, never a child's finishing early.
 *
 * Scoped rather than general: for agents whose hooks do report child turns, a `done` row
 * can arrive mid-turn, and settling on it is exactly the #6011 class this file exists to
 * prevent.
 *
 * The second lane is narrower and agent-agnostic: a `sessionBoundary` row does not claim a
 * turn ended, it claims a NEW SESSION owns the pane and is waiting for its first input. That
 * cannot arrive mid-turn by construction — the producers only set it for a startup/resume/
 * reset boundary — so it carries no #6011 risk for any agent that emits it.
 */
export function hasFreshDoneFirstPartyStatus(
  agent: TuiAgent | null | undefined,
  status: FirstPartyAgentStatus,
  staleAfterMs = AGENT_STATUS_STALE_AFTER_MS
): boolean {
  if (status?.state !== 'done' || (agent !== 'dsh' && status.sessionBoundary !== true)) {
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
  if (resolved === null) {
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
  quiescenceMs: number
): boolean {
  if (record.lastAgentStatus !== 'idle') {
    return false
  }
  if (!nameOnlyIdleNeedsCorroboration(agent, record.lastOscTitle)) {
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

function quietForegroundLane(agent: TuiAgent | null | undefined): QuietForegroundLane {
  if (!agent) {
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
  /** Tier 1 body evidence: a known ready prompt, or an adopted pane's explicit title.
   *  A thunk because producing it means building the pane's wait text and lowercasing it
   *  (~11us and a multi-KB string on a full tail); the title check below usually answers
   *  first, and then none of that has to happen at all. */
  readPositiveBodyEvidence: () => boolean
  /** Tier 1b body evidence: a Muse ready screen, or a rule-file one held to quiet. Thunk, as above. */
  readQuietReadyBodyEvidence: () => boolean
  /** The agent's own rules' answer; any answer shuts the lanes that cannot see its screen. */
  readAgentRuleVerdict: () => AgentStateVerdict | null
  agent: TuiAgent | null | undefined
  firstPartyStatus: FirstPartyAgentStatus
  /** Tier 0: the hook server's fresh row for the pane, read only for an authoritative agent. */
  readHookTurn?: () => TuiIdleHookTurn | null
  quiescenceMs: number
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
  const hookVerdict = input.readHookTurn ? evaluateHookTurn(input.agent, input.readHookTurn) : null
  if (hookVerdict) {
    return hookVerdict
  }
  const blockedReason = input.readTailBlockedReason()
  if (blockedReason) {
    return { kind: 'blocked', reason: blockedReason }
  }
  // Qoder publishes "Ready" before its trust dialog is dismissed; only its composer proves input is live.
  if (input.agent === 'qoder') {
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
  if (hasFreshDoneFirstPartyStatus(input.agent, input.firstPartyStatus)) {
    return READY_STRONG
  }
  if (hasFreshWorkingFirstPartyStatus(input.firstPartyStatus)) {
    // Why blocked/waiting stays pending: the agent says it is waiting on the user, which is
    // when a dialog is on screen, so the screen read must still run.
    return input.firstPartyStatus?.state === 'working'
      ? WORKING
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
    return isSettledWeakIdle(ruled, input.record, input.quiescenceMs)
      ? READY_WEAK
      : { kind: 'pending', quietForeground: 'closed' }
  }
  if (hasSustainedTitleIdle(input.record, input.agent, input.quiescenceMs)) {
    return READY_WEAK
  }
  return {
    kind: 'pending',
    quietForeground:
      input.record.lastAgentStatus === null ? quietForegroundLane(input.agent) : 'closed'
  }
}

function isSettledWeakIdle(
  verdict: AgentStateVerdict,
  record: TuiIdleEvidenceRecord,
  quiescenceMs: number
): boolean {
  return (
    verdict.state === 'idle' &&
    verdict.strength === 'weak' &&
    (!verdict.requiresQuiet || hasQuietOutput(record, quiescenceMs))
  )
}

export function isTuiIdleReadyVerdict(verdict: TuiIdleVerdict): boolean {
  return verdict.kind === 'ready-strong' || verdict.kind === 'ready-weak'
}

/** The runtime state every tui-idle site reads its evidence from. */
export type TuiIdleEvidenceSource = {
  quiescenceMs: number
  getTabTitle(tabId: string): string | null
  getAdoptedPtyIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null
  getPaneAgent(ptyId: string | null | undefined): TuiAgent | null
  getFirstPartyAgentStatus(ptyId: string | null | undefined): FirstPartyAgentStatus
  /** The hook server's fresh row for the pane's main agent; absent on a host with no store. */
  getHookTurn?(ptyId: string, agent: TuiAgent): TuiIdleHookTurn | null
  readScreenLines(ptyId: string | null | undefined): readonly string[] | null
  /** The painted rows on the PTY's own grid, which only agents whose rules read the trusted
   *  screen use. Absent, they have no trustworthy screen. */
  readScreenRuledLines?(ptyId: string | null | undefined): readonly string[] | null
}

// Why per agent: every other agent keeps the live screen its rules were recorded against.
// Why read once: several lanes consult the rules, and one evaluation sees one screen.
function screenReader(
  source: TuiIdleEvidenceSource,
  agent: TuiAgent | null,
  ptyId: string | null | undefined
): () => readonly string[] | null {
  let lines: readonly string[] | null | undefined
  const read = readsTrustedScreen(agent)
    ? () => source.readScreenRuledLines?.(ptyId) ?? null
    : () => source.readScreenLines(ptyId)
  return () => (lines === undefined ? (lines = read()) : lines)
}

function readAgentRuleVerdict(
  agent: TuiAgent | null,
  record: TuiIdleEvidenceRecord,
  readScreenLines: () => readonly string[] | null,
  waitText: () => string
): AgentStateVerdict | null {
  return evaluateAgentStateRules(agent, {
    readScreenLines,
    readText: () => waitText().toLowerCase(),
    readTitleStatus: () => record.lastAgentStatus,
    hasOutputClock: record.lastOutputAt !== null
  })
}

function hookTurnReader(
  source: TuiIdleEvidenceSource,
  agent: TuiAgent | null,
  ptyId: string | null | undefined
): (() => TuiIdleHookTurn | null) | undefined {
  return source.getHookTurn && agent && ptyId
    ? () => source.getHookTurn?.(ptyId, agent) ?? null
    : undefined
}

function lazyWaitText(readWaitText: () => string): () => string {
  let waitText: string | null = null
  return () => (waitText ??= readWaitText())
}

export function leafTuiIdleEvidence(
  source: TuiIdleEvidenceSource,
  leaf: RuntimeLeafRecord,
  readWaitText: () => string
): TuiIdleEvaluationInput {
  const waitText = lazyWaitText(readWaitText)
  const agent = source.getPaneAgent(leaf.ptyId)
  const readScreen = screenReader(source, agent, leaf.ptyId)
  return {
    record: leaf,
    readTailBlockedReason: () => detectTerminalWaitBlockedReason(waitText()),
    rendererTitle: leaf.paneTitle ?? source.getTabTitle(leaf.tabId),
    readPositiveBodyEvidence: () =>
      isKnownReadyPromptBody(waitText(), agent, readScreen, leaf.lastOutputAt !== null),
    readQuietReadyBodyEvidence: () => isQuietReadyScreenBody(waitText(), agent, readScreen),
    readAgentRuleVerdict: () => readAgentRuleVerdict(agent, leaf, readScreen, waitText),
    agent,
    firstPartyStatus: source.getFirstPartyAgentStatus(leaf.ptyId),
    readHookTurn: hookTurnReader(source, agent, leaf.ptyId),
    quiescenceMs: source.quiescenceMs
  }
}

export function ptyTuiIdleEvidence(
  source: TuiIdleEvidenceSource,
  pty: RuntimePtyWorktreeRecord,
  readWaitText: () => string
): TuiIdleEvaluationInput {
  const waitText = lazyWaitText(readWaitText)
  const agent = source.getPaneAgent(pty.ptyId)
  const readScreen = screenReader(source, agent, pty.ptyId)
  return {
    record: pty,
    readTailBlockedReason: () => detectTerminalWaitBlockedReason(waitText()),
    readPositiveBodyEvidence: () =>
      (agent !== 'qoder' && source.getAdoptedPtyIdleStatus(pty) === 'idle') ||
      isKnownReadyPromptBody(waitText(), agent, readScreen, pty.lastOutputAt !== null),
    readQuietReadyBodyEvidence: () => isQuietReadyScreenBody(waitText(), agent, readScreen),
    readAgentRuleVerdict: () => readAgentRuleVerdict(agent, pty, readScreen, waitText),
    agent,
    firstPartyStatus: source.getFirstPartyAgentStatus(pty.ptyId),
    readHookTurn: hookTurnReader(source, agent, pty.ptyId),
    quiescenceMs: source.quiescenceMs
  }
}
