import { escapeRegex } from '../../../shared/string-utils'
import { findStartupDialogBlockedSignals } from '../startup-dialog-blocked-signals'
import { startOfLastNonBlankLines } from '../terminal-wait-tail-window'
import { compiledFromActiveAgentStateRules } from './active-agent-state-rules'
import {
  blockedAnchorLiterals,
  findBlockedAnchorSignals,
  showsHoldAnchor,
  type BlockedTextSignal
} from './agent-state-text-anchors'

// Any pane can contain another agent's dialog; the latest live blocker wins.

const BUILT_IN_SENTINEL_RE =
  /update available|choose working directory to|codex just got an upgrade|available\s*\u00B7|esc\s*skip|enter\s*confirm\s*\u00B7|enter\/esc\s*(?:continue|confirm)|hooks need review|do you trust|trust this|trusted workspace|press enter to (?:confirm|continue|view|insert)|press t to trust|permission required|requires permission|allow once|allow always/

/** Cheap negative test; identity remains stable until rules change for caller caches. */
export const terminalWaitBlockedSentinelRe = compiledFromActiveAgentStateRules(
  () =>
    new RegExp(
      [BUILT_IN_SENTINEL_RE.source, ...blockedAnchorLiterals().map(escapeRegex)].join('|'),
      'i'
    )
)

// Restrict to the screen bottom: answered dialogs and quoted prompts remain in scrollback.
// Twelve lines cover 4–8-line Codex dialogs plus wrapped commands/hooks.
const LIVE_PROMPT_TAIL_LINES = 12

/** `wholeText` scans every line: a grid holds only what is painted, and a tall dialog's keyword sits above the window. */
export function findTerminalWaitBlockedSignal(
  fullTail: string,
  options: { wholeText?: boolean } = {}
): BlockedTextSignal | null {
  const windowStart = options.wholeText
    ? 0
    : startOfLastNonBlankLines(fullTail, LIVE_PROMPT_TAIL_LINES)
  const normalized = windowStart === 0 ? fullTail : fullTail.slice(windowStart)
  if (!terminalWaitBlockedSentinelRe().test(normalized)) {
    return null
  }
  const signal = findBlockedSignalInLiveWindow(normalized)
  // Convert the live-window index to full-tail coordinates for ready-header comparison.
  return signal === null ? null : { reason: signal.reason, index: signal.index + windowStart }
}

export function isUnblockedAfter(normalized: string, readyIndex: number | null): boolean {
  if (readyIndex === null) {
    return false
  }
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  return blockedSignal === null || blockedSignal.index <= readyIndex
}

export function isSettledAfter(normalized: string, readyIndex: number | null): boolean {
  return isUnblockedAfter(normalized, readyIndex) && !showsHoldAnchor(normalized)
}

function findBlockedSignalInLiveWindow(normalized: string): BlockedTextSignal | null {
  const candidates = findStartupDialogBlockedSignals(normalized)
  const trustIndex = Math.max(
    normalized.lastIndexOf('do you trust'),
    normalized.lastIndexOf('trust this'),
    normalized.lastIndexOf('trusted workspace')
  )
  const trustSegment = trustIndex === -1 ? '' : normalized.slice(trustIndex)
  if (
    trustIndex !== -1 &&
    (trustSegment.includes('workspace') ||
      trustSegment.includes('folder') ||
      trustSegment.includes('directory') ||
      trustSegment.includes('repo'))
  ) {
    // Workspace-trust wording identifies no particular agent.
    candidates.push({ reason: 'agent-trust-workspace', index: trustIndex })
  }
  const interactivePromptIndex = Math.max(
    normalized.lastIndexOf('press enter to confirm'),
    normalized.lastIndexOf('press enter to continue'),
    normalized.lastIndexOf('press enter to view'),
    normalized.lastIndexOf('press enter to insert'),
    normalized.lastIndexOf('press t to trust')
  )
  const interactivePromptContext =
    interactivePromptIndex === -1
      ? ''
      : normalized.slice(Math.max(0, interactivePromptIndex - 600), interactivePromptIndex + 200)
  // Codex in scrollback widens dialog detection but cannot identify the pane's agent.
  const hasInteractiveDialogContext =
    interactivePromptContext.includes('codex') ||
    interactivePromptContext.includes('permission') ||
    interactivePromptContext.includes('sandbox') ||
    interactivePromptContext.includes('trust') ||
    interactivePromptContext.includes('hook')
  if (interactivePromptIndex !== -1 && hasInteractiveDialogContext) {
    const contextStart = Math.max(0, interactivePromptIndex - 600)
    const hasSpecificPromptInContext = candidates.some(
      (candidate) => candidate.index >= contextStart && candidate.index <= interactivePromptIndex
    )
    if (!hasSpecificPromptInContext) {
      candidates.push({ reason: 'agent-interactive-prompt', index: interactivePromptIndex })
    }
  }
  candidates.push(...findBlockedAnchorSignals(normalized))
  const permissionPromptIndex = Math.max(
    normalized.lastIndexOf('permission required'),
    normalized.lastIndexOf('requires permission')
  )
  if (permissionPromptIndex !== -1) {
    const permissionSegment = normalized.slice(permissionPromptIndex, permissionPromptIndex + 1_500)
    const decisionCount = ['allow once', 'allow always', 'reject', 'deny'].filter((choice) =>
      permissionSegment.includes(choice)
    ).length
    if (decisionCount >= 2) {
      // Named choices identify no agent; retain the old codex-* alias for mixed-version receipts.
      // Rule 1 additive member: RuntimeTerminalWaitBlockedReason has no exhaustive consumers (remote-wire-compatibility.md).
      candidates.push({ reason: 'agent-interactive-prompt', index: permissionPromptIndex })
    }
  }
  return candidates.length > 0
    ? candidates.reduce((latest, candidate) =>
        candidate.index > latest.index ? candidate : latest
      )
    : null
}
