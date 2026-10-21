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

/**
 * The shared blocked layer, read before any agent's own rules. Why shared and positional: a tail
 * can show any agent's dialog whatever the pane runs, and an answered dialog stays in it, so the
 * blocker painted latest wins.
 */

const BUILT_IN_SENTINEL_RE =
  /update available|choose working directory to|codex just got an upgrade|available\s*·|esc\s*skip|enter\s*confirm\s*·|enter\/esc\s*(?:continue|confirm)|hooks need review|do you trust|trust this|trusted workspace|press enter to (?:confirm|continue|view|insert)|press t to trust|permission required|requires permission|allow once|allow always/

/**
 * Matches any line that may carry a blocker; a cheap negative test before the full scan. The same
 * object until the active rules change, so a caller may key cached matches on it.
 */
export const terminalWaitBlockedSentinelRe = compiledFromActiveAgentStateRules(
  () =>
    new RegExp(
      [BUILT_IN_SENTINEL_RE.source, ...blockedAnchorLiterals().map(escapeRegex)].join('|'),
      'i'
    )
)

// Why bounded: answered dialogs and quoted prompt wording (agents grep this file and its specs) stay in the
// retained tail; only a dialog owning the screen bottom is live. Real Codex dialogs (trust, hooks review,
// update, exec approval) are 4-8 lines; the slack covers a wrapped command or a longer hook list.
const LIVE_PROMPT_TAIL_LINES = 12

export function findTerminalWaitBlockedSignal(fullTail: string): BlockedTextSignal | null {
  const windowStart = startOfLastNonBlankLines(fullTail, LIVE_PROMPT_TAIL_LINES)
  const normalized = windowStart === 0 ? fullTail : fullTail.slice(windowStart)
  // Why: one combined negative scan avoids a dozen searches when no prompt can match.
  if (!terminalWaitBlockedSentinelRe().test(normalized)) {
    return null
  }
  const signal = findBlockedSignalInLiveWindow(normalized)
  // Why: callers compare this index against ready-header indexes found over the full tail.
  return signal === null ? null : { reason: signal.reason, index: signal.index + windowStart }
}

/** Whether a ready sign at `readyIndex` still owns the text: no blocker was painted after it. */
export function isUnblockedAfter(normalized: string, readyIndex: number | null): boolean {
  if (readyIndex === null) {
    return false
  }
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  return blockedSignal === null || blockedSignal.index <= readyIndex
}

/** Unblocked, and no hold anchor says the agent behind it is still starting: input would land. */
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
    // Why neutral: this matcher never inspects the agent -- every TUI agent ships a workspace-trust dialog.
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
  // Why 'codex' only widens detection and never names the reason: the sole Codex evidence here is
  // that word somewhere in 600 chars of scrollback, which an agent narrating about Codex satisfies
  // on any pane -- enough to suspect a dialog, not enough to label a non-Codex user's pane.
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
  // Why after the generic prompt: it yields only to the startup and trust dialogs above.
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
      // Why neutral: an approval dialog with named choices identifies no agent; older hosts publish
      // 'codex-interactive-prompt' here and clients alias the two. Rule 1 additive member --
      // remote-wire-compatibility.md names RuntimeTerminalWaitBlockedReason as Rule 1 because no
      // consumer switches exhaustively on it.
      // Why alias rather than drop the old spelling: preserve the existing remote receipt value for
      // mixed-version clients -- an older host still publishes codex-* on this path.
      candidates.push({ reason: 'agent-interactive-prompt', index: permissionPromptIndex })
    }
  }
  return candidates.length > 0
    ? candidates.reduce((latest, candidate) =>
        candidate.index > latest.index ? candidate : latest
      )
    : null
}
