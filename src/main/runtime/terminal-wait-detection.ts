import { isQoderComposerReady } from './qoder-terminal-readiness'
import { memoizeTitleClassification } from '../../shared/terminal-title-classification-memo'
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
import { compiledFromActiveAgentStateRules } from './agent-state-rules/active-agent-state-rules'
import {
  findTerminalWaitBlockedSignal,
  isSettledAfter,
  isUnblockedAfter
} from './agent-state-rules/blocked-text-layer'

// Include Orca ready titles and agents that state rest in words.
const EXPLICIT_IDLE_TITLE_RE = /(^|\s)(ready|idle|done)(\s|$|[.!?])/i

function computeExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  const status = detectAgentStatusFromTitle(title)
  // Agent-name launch titles such as Codex YOLO do not prove readiness.
  return status === 'idle' && (EXPLICIT_IDLE_TITLE_RE.test(title) || showsIdleTitleAnchor(title))
    ? 'idle'
    : null
}

/** Polls and repaints repeat unchanged titles; memoize per rule set so reloads invalidate classification. */
const explicitIdleTitleMemo = compiledFromActiveAgentStateRules(() =>
  memoizeTitleClassification(computeExplicitIdleStatusFromTitle)
)

export function detectExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  return explicitIdleTitleMemo()(title)
}

export function isKnownReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isUnblockedAfter(normalized, findPromptAnchorIndexes(normalized).ready)
}

/** Codex 0.157 discards input behind its provisional startup header; hold anchors veto ready text. */
export function isKnownReadyPromptSettled(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isSettledAfter(normalized, findPromptAnchorIndexes(normalized).ready)
}

/** Agent screen refusals also veto shared text. Quiet-only rules settle here only without an output clock; clocked panes use isQuietReadyScreenBody. */
export function isKnownReadyPromptBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null,
  hasOutputClock: boolean
): boolean {
  if (agent === 'qoder' || agent === 'qoder-cn') {
    return isQoderComposerReady(readScreenLines())
  }
  // With an output clock, this agent settles only after quiet.
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

/** Mid-turn ready screens/text require quiet. Require Muse identity so pasted transcripts and pagers cannot settle unknown panes. */
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
  // A later live prompt dismisses the modal even mid-turn; Cursor never titles itself idle.
  return dismissedModalIndex !== null && dismissedModalIndex > blockedSignal.index
    ? null
    : blockedSignal
}

// Live idle/busy prompts supersede startup modals; Muse still needs anchors outside agent-state-rules.
function findDismissedStartupModalIndex(normalized: string): number | null {
  const live = findPromptAnchorIndexes(normalized).live
  const muse = findMuseReadyPromptIndex(normalized)
  return live === null || muse === null ? (live ?? muse) : Math.max(live, muse)
}

// Muse keeps its bare-cwd OSC title; only the body proves readiness, including the voice composer without skills.
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
