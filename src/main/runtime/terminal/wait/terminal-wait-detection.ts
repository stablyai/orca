import { isQoderComposerReady } from './qoder-terminal-readiness'
import { memoizeTitleClassification } from '../../../../shared/agent-status/title/terminal-title-classification-memo'
import { detectAgentStatusFromTitle } from '../../../../shared/agent-status/title/agent-title-status'
import type { AgentStatus } from '../../../../shared/agent-status/title/agent-title-core'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-terminal-contracts'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  evaluateAgentStateRules,
  hasQuietReadyRules,
  holdsReadyTextToQuiet,
  type AgentStateVerdict
} from '../../agent-state-rules/agent-state-rules-engine'
import { findPromptAnchorIndexes } from '../../agent-state-rules/agent-state-text-anchors'
import { showsIdleTitleAnchor } from '../../agent-state-rules/agent-state-title-anchors'
import { compiledFromActiveAgentStateRules } from '../../agent-state-rules/active-agent-state-rules'
import {
  findTerminalWaitBlockedSignal,
  isSettledAfter,
  isUnblockedAfter
} from '../../agent-state-rules/blocked-text-layer'
import {
  lowercaseTerminalSupport,
  offsetTerminalSupport,
  type TerminalContentOrigin,
  type TerminalSupportQuery
} from '../../../../shared/terminal/output/terminal-content-origin'
import {
  lastSupportedIndex,
  supportedRegexMatches
} from '../../../../shared/terminal/output/terminal-supported-occurrences'

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
export function isKnownReadyPromptSettled(
  preview: string,
  support?: TerminalSupportQuery
): boolean {
  const normalized = lowercaseTerminalSupport(preview, support)
  return isSettledAfter(
    normalized.text,
    findPromptAnchorIndexes(normalized.text, normalized.query).ready,
    normalized.query
  )
}

/** Agent screen refusals also veto shared text. Quiet-only rules settle here only without an output clock; clocked panes use isQuietReadyScreenBody. */
export function isKnownReadyPromptBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null,
  hasOutputClock: boolean,
  support?: TerminalSupportQuery,
  contentScope?: TerminalContentOrigin
): boolean {
  if (agent === 'qoder' || agent === 'qoder-cn') {
    return isQoderComposerReady(readScreenLines(), contentScope)
  }
  // With an output clock, this agent settles only after quiet.
  if (hasOutputClock && holdsReadyTextToQuiet(agent)) {
    return false
  }
  const ruled = evaluateAgentStateRules(agent, {
    readScreenLines,
    readText: () => waitText.toLowerCase(),
    hasOutputClock,
    textSupport: lowercaseTerminalSupport(waitText, support).query,
    contentScope
  })
  if (ruled !== null) {
    return isStrongIdle(ruled) && (!ruled.requiresQuiet || !hasOutputClock)
  }
  return isKnownReadyPromptSettled(waitText, support)
}

/** Mid-turn ready screens/text require quiet. Require Muse identity so pasted transcripts and pagers cannot settle unknown panes. */
export function isQuietReadyScreenBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null,
  support?: TerminalSupportQuery,
  contentScope?: TerminalContentOrigin
): boolean {
  if (hasQuietReadyRules(agent)) {
    const ruled = evaluateAgentStateRules(agent, {
      readScreenLines,
      readText: () => waitText.toLowerCase(),
      textSupport: lowercaseTerminalSupport(waitText, support).query,
      contentScope
    })
    return ruled !== null && isStrongIdle(ruled) && ruled.requiresQuiet
  }
  return (agent === null || agent === 'muse') && isMuseReadyPromptPreview(waitText, support)
}

function isStrongIdle(
  verdict: AgentStateVerdict
): verdict is Extract<AgentStateVerdict, { state: 'idle' }> {
  return verdict.state === 'idle' && verdict.strength === 'strong'
}

export function isMuseReadyPromptPreview(preview: string, support?: TerminalSupportQuery): boolean {
  const normalized = lowercaseTerminalSupport(preview, support)
  return isUnblockedAfter(
    normalized.text,
    findMuseReadyPromptIndex(normalized.text, normalized.query),
    normalized.query
  )
}

export function detectTerminalWaitBlockedReason(
  preview: string,
  support?: TerminalSupportQuery
): RuntimeTerminalWaitBlockedReason | null {
  const normalized = lowercaseTerminalSupport(preview, support)
  return findActionableTerminalWaitBlockedSignal(normalized.text, normalized.query)?.reason ?? null
}

export function findActionableTerminalWaitBlockedSignal(
  normalized: string,
  support?: TerminalSupportQuery
): { reason: RuntimeTerminalWaitBlockedReason; index: number } | null {
  const blockedSignal = findTerminalWaitBlockedSignal(normalized, { support })
  if (blockedSignal === null) {
    return null
  }
  const dismissedModalIndex = findDismissedStartupModalIndex(normalized, support)
  // A later live prompt dismisses the modal even mid-turn; Cursor never titles itself idle.
  return dismissedModalIndex !== null && dismissedModalIndex > blockedSignal.index
    ? null
    : blockedSignal
}

// Live idle/busy prompts supersede startup modals; Muse still needs anchors outside agent-state-rules.
function findDismissedStartupModalIndex(
  normalized: string,
  support?: TerminalSupportQuery
): number | null {
  const live = findPromptAnchorIndexes(normalized, support).live
  const muse = findMuseReadyPromptIndex(normalized, support)
  return live === null || muse === null ? (live ?? muse) : Math.max(live, muse)
}

// Muse keeps its bare-cwd OSC title; its composer (❯ under a rule, labeled "voice input" only where voice exists) proves readiness.
const MUSE_COMPOSER_RE = /\u2500\u2500\s*\u276F/

function findMuseReadyPromptIndex(
  normalized: string,
  support?: TerminalSupportQuery
): number | null {
  const headerIndex = lastSupportedIndex(normalized, 'muse code', support)
  if (headerIndex === -1) {
    return null
  }
  const segment = normalized.slice(headerIndex)
  const query = offsetTerminalSupport(support, headerIndex)
  const voiceComposer = ['voice', 'input', '❯'].every(
    (term) => lastSupportedIndex(segment, term, query) !== -1
  )
  return voiceComposer || supportedRegexMatches(segment, MUSE_COMPOSER_RE, query).length > 0
    ? headerIndex
    : null
}
