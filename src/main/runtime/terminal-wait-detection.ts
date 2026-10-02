import { isQoderComposerReady } from './qoder-terminal-readiness'
import { memoizeTitleClassification } from '../../shared/terminal-title-classification-memo'
import { getPiStateTitleStatus } from '../../shared/pi-state-title-marker'
import { detectAgentStatusFromTitle, type AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  evaluateAgentStateRules,
  hasQuietReadyRules,
  holdsReadyTextToQuiet,
  type AgentStateVerdict
} from './agent-state-rules/agent-state-rules-engine'
import { findPromptAnchorIndexes } from './agent-state-rules/agent-state-text-anchors'
import { showsIdleTitleAnchor } from './agent-state-rules/agent-state-title-anchors'
import {
  findTerminalWaitBlockedSignal,
  isSettledAfter,
  isUnblockedAfter
} from './agent-state-rules/blocked-text-layer'

// Why agent-agnostic: Orca's own `<Agent> ready` titles, and any agent title stating rest in words.
const EXPLICIT_IDLE_TITLE_RE = /(^|\s)(ready|idle|done)(\s|$|[.!?])/i

function computeExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  const status = detectAgentStatusFromTitle(title)
  // Why: launch titles like "Codex YOLO" contain an agent name but aren't readiness signals; terminal.wait needs explicit idle evidence.
  return status === 'idle' &&
    (EXPLICIT_IDLE_TITLE_RE.test(title) ||
      showsIdleTitleAnchor(title) ||
      getPiStateTitleStatus(title) === 'idle')
    ? 'idle'
    : null
}

/**
 * Pure in `title`, so it is memoized on the title string like the status classifier it
 * wraps: the wait path re-asks for the same unchanged title on every poll tick and every
 * repaint frame, and the marker scan below is a regex sweep each time (~72ns vs ~7ns).
 */
export const detectExplicitIdleStatusFromTitle: (title: string) => AgentStatus | null =
  memoizeTitleClassification(computeExplicitIdleStatusFromTitle)

export function isKnownReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isUnblockedAfter(normalized, findPromptAnchorIndexes(normalized).ready)
}

/**
 * The ready-prompt text rules for a pane about to take input. Unlike isKnownReadyPromptPreview
 * (agent presence), nothing counts while a hold anchor shows (Codex's provisional startup header):
 * 0.157 discards input typed behind it while its daemon starts.
 */
export function isKnownReadyPromptSettled(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isSettledAfter(normalized, findPromptAnchorIndexes(normalized).ready)
}

/**
 * Tier 1 body evidence for every tui-idle site. `readScreenLines` yields the screen the agent's
 * rules read, or null when the runtime has no trustworthy one.
 *
 * Why the agent's own answer is final: a screen refusal must shut the shared text lane too.
 * A strong rule held to quiet counts here only on a clockless pane, which cannot measure quiet;
 * on a clocked one isQuietReadyScreenBody holds it to quiescence instead, and an agent whose
 * own ready text is held to quiet takes no shared text either.
 */
export function isKnownReadyPromptBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null,
  hasOutputClock: boolean
): boolean {
  if (agent === 'qoder') {
    return isQoderComposerReady(readScreenLines())
  }
  // Why before the rules: such an agent settles only on the quiet lane while it has a clock.
  if (hasOutputClock && holdsReadyTextToQuiet(agent)) {
    return false
  }
  const ruled = evaluateAgentStateRules(agent, {
    readScreenLines,
    readText: () => waitText.toLowerCase(),
    hasOutputClock
  })
  if (ruled !== null) {
    return isStrongIdle(ruled) && (!ruled.requiresQuiet || !hasOutputClock)
  }
  return isKnownReadyPromptSettled(waitText)
}

/**
 * Tier 1b body evidence: a ready screen or text the agent also paints mid-turn, so the ranking
 * holds it to quiescence. Why identified panes only for Muse: a `cat`ed transcript or pager in an
 * unknown pane can show the composer.
 */
export function isQuietReadyScreenBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null
): boolean {
  if (hasQuietReadyRules(agent)) {
    const ruled = evaluateAgentStateRules(agent, {
      readScreenLines,
      readText: () => waitText.toLowerCase()
    })
    return ruled !== null && isStrongIdle(ruled) && ruled.requiresQuiet
  }
  return (agent === null || agent === 'muse') && isMuseReadyPromptPreview(waitText)
}

function isStrongIdle(
  verdict: AgentStateVerdict
): verdict is Extract<AgentStateVerdict, { state: 'idle' }> {
  return verdict.state === 'idle' && verdict.strength === 'strong'
}

export function isMuseReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isUnblockedAfter(normalized, findMuseReadyPromptIndex(normalized))
}

export function detectTerminalWaitBlockedReason(
  preview: string
): RuntimeTerminalWaitBlockedReason | null {
  const normalized = preview.toLowerCase()
  return findActionableTerminalWaitBlockedSignal(normalized)?.reason ?? null
}

export function findActionableTerminalWaitBlockedSignal(
  normalized: string
): { reason: RuntimeTerminalWaitBlockedReason; index: number } | null {
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  if (blockedSignal === null) {
    return null
  }
  const dismissedModalIndex = findDismissedStartupModalIndex(normalized)
  // Why: a live prompt after the modal means it was dismissed → signal no longer actionable, even mid-run (Cursor never reports idle via OSC title).
  return dismissedModalIndex !== null && dismissedModalIndex > blockedSignal.index
    ? null
    : blockedSignal
}

// Why: a live prompt (idle OR busy) proves the startup modal was dismissed, so a mid-run Cursor lane stops reporting stale trust hits.
// Why Muse beside the rule-file anchors: Muse has not moved to agent-state-rules/ yet.
function findDismissedStartupModalIndex(normalized: string): number | null {
  const live = findPromptAnchorIndexes(normalized).live
  const muse = findMuseReadyPromptIndex(normalized)
  return live === null || muse === null ? (live ?? muse) : Math.max(live, muse)
}

// Why: Muse titles its OSC with the bare cwd and never updates it, so only the body can
// prove the TUI is up. The voice-input composer is present even without loaded skills.
function findMuseReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('muse code')
  if (headerIndex === -1) {
    return null
  }
  const segment = normalized.slice(headerIndex)
  return segment.includes('voice') && segment.includes('input') && segment.includes('❯')
    ? headerIndex
    : null
}
