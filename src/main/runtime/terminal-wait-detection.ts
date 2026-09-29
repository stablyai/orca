import { isQoderComposerReady } from './qoder-terminal-readiness'
import { memoizeTitleClassification } from '../../shared/terminal-title-classification-memo'
import {
  detectAgentStatusFromTitle,
  isOpenCodeNativeTitle,
  type AgentStatus
} from '../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { findAntigravityReadyPromptIndex } from './antigravity-terminal-readiness'
import { findCursorApprovalPromptIndex } from './terminal-wait-cursor-approval'
import {
  classifyCodexScreenReadiness,
  findCodexReadyPromptIndex,
  hasCodexComposerEvidence
} from './codex-terminal-readiness'
import { startOfLastNonBlankLines } from './terminal-wait-tail-window'

const EXPLICIT_IDLE_TITLE_RE = /(^|\s)(ready|idle|done)(\s|$|[.!?])/i
const CLAUDE_IDLE_PREFIX = '\u2733'
const GEMINI_IDLE_PREFIX = '\u25c7'
const PI_IDLE_PREFIX = '\u03c0 - '

function computeExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  const status = detectAgentStatusFromTitle(title)
  if (status !== 'idle') {
    return null
  }
  // Why: launch titles like "Codex YOLO" contain an agent name but aren't readiness signals; terminal.wait needs explicit idle evidence.
  if (
    EXPLICIT_IDLE_TITLE_RE.test(title) ||
    // Why: unblock hookless remote waits; guarded writes corroborate this marker.
    isOpenCodeNativeTitle(title) ||
    title.startsWith(CLAUDE_IDLE_PREFIX) ||
    title.startsWith('* ') ||
    title.includes(GEMINI_IDLE_PREFIX) ||
    title.startsWith(PI_IDLE_PREFIX)
  ) {
    return 'idle'
  }
  return null
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
  return isReadyPromptUnblocked(normalized, findKnownReadyPromptIndex(normalized))
}

/**
 * Tier 1 body evidence for every tui-idle site. `readScreenLines` yields the live emulator's
 * visible grid, or null when the runtime has no trustworthy one.
 *
 * Why the screen: Codex repaints its header by cell diff (`ESC[5;3Hdir ESC[5;7Hctory:`), which
 * only a grid reassembles — the line-folded wait text reads `dirctory:` forever.
 * Why it can only add readiness: a grid out of step with the PTY (size mismatch, resize
 * mid-paint) garbles the header, so the text rules keep every verdict they give today.
 */
export function isKnownReadyPromptBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null,
  readCurrentCodexComposerSignal: () => boolean = () => false
): boolean {
  if (agent === 'qoder') {
    return isQoderComposerReady(readScreenLines())
  }
  const normalizedWaitText = waitText.toLowerCase()
  const waitBlockedSignal = findActionableTerminalWaitBlockedSignal(normalizedWaitText)
  const codexScreenLines = agent === 'codex' ? readScreenLines() : null
  const codexScreenReadiness =
    codexScreenLines === null
      ? null
      : classifyCodexScreenReadiness(
          codexScreenLines,
          readCurrentCodexComposerSignal(),
          (screen) => findActionableTerminalWaitBlockedSignal(screen) !== null
        )
  // A visible blocker or in-flight turn always vetoes retained text. The current rendered screen
  // is the only evidence that can settle Codex; text is a compatibility fallback only when the
  // renderer has no provider-specific state to classify (for example, a repaint-sized garble).
  if (waitBlockedSignal !== null && (agent !== 'codex' || codexScreenReadiness !== 'ready')) {
    return false
  }
  if (agent === 'codex' && codexScreenReadiness !== null) {
    if (codexScreenReadiness === 'blocked' || codexScreenReadiness === 'pending') {
      return false
    }
    if (codexScreenReadiness === 'ready') {
      return true
    }
  }
  if (isKnownReadyPromptPreview(waitText)) {
    if (agent !== 'codex' || codexScreenLines === null) {
      return true
    }
    // A current provider read can be a garbled 80x24 repaint with no Codex identity cells left.
    // The visible-read probe's epoch/retry fence makes this text a same-frame compatibility
    // fallback, but only a composer-shaped current screen can authorize it. Identifiable
    // unframed headers remain pending above and cannot reach this branch.
    return codexScreenReadiness === 'unknown' && hasCodexComposerEvidence(codexScreenLines)
  }
  // Why the agent gate: another agent's screen can merely mention "OpenAI Codex".
  if (agent !== null && agent !== 'codex') {
    return false
  }
  const screenLines = codexScreenLines
  if (screenLines === null) {
    // The scanner is only a watermark for a rendered composer. It cannot prove that the
    // provider still owns the live screen after a handoff or repaint.
    return false
  }
  return codexScreenReadiness === 'ready'
}

function isReadyPromptUnblocked(normalized: string, readyIndex: number | null): boolean {
  if (readyIndex === null) {
    return false
  }
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  return blockedSignal === null || blockedSignal.index <= readyIndex
}

// Why separate from isKnownReadyPromptPreview: that one settles tier 1 immediately, while
// a Muse ready screen only proves the TUI is up — the ranking holds it to quiescence.
export function isMuseReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isReadyPromptUnblocked(normalized, findMuseReadyPromptIndex(normalized))
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
function findDismissedStartupModalIndex(normalized: string): number | null {
  const indexes = [
    findCodexReadyPromptIndex(normalized),
    findAntigravityReadyPromptIndex(normalized),
    findCursorActivePromptIndex(normalized),
    findMuseReadyPromptIndex(normalized)
  ].filter((index): index is number => index !== null)
  return indexes.length > 0 ? Math.max(...indexes) : null
}

function findKnownReadyPromptIndex(normalized: string): number | null {
  const indexes = [
    findCodexReadyPromptIndex(normalized),
    findAntigravityReadyPromptIndex(normalized),
    findCursorReadyPromptIndex(normalized)
  ].filter((index): index is number => index !== null)
  return indexes.length > 0 ? Math.max(...indexes) : null
}

// Why: match the banner's last occurrence to skip the trust dialog's own "Cursor Agent" text; "→" is cursor-agent's persistent input prompt.
function findCursorActivePromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('cursor agent')
  if (headerIndex === -1) {
    return null
  }
  return normalized.includes('→', headerIndex) ? headerIndex : null
}

// Why: cursor-agent emits no idle OSC title; infer idle from the tail (braille spinner = busy, its absence = idle).
const CURSOR_BUSY_SPINNER_RE = /[⠁-⣿]/

function findCursorReadyPromptIndex(normalized: string): number | null {
  const activeIndex = findCursorActivePromptIndex(normalized)
  if (activeIndex === null) {
    return null
  }
  return CURSOR_BUSY_SPINNER_RE.test(normalized.slice(activeIndex)) ? null : activeIndex
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

export const TERMINAL_WAIT_BLOCKED_SENTINEL_RE =
  /update available|choose working directory to|codex just got an upgrade|hooks need review|do you trust|trust this|trusted workspace|press enter to (?:confirm|continue|view|insert)|press t to trust|permission required|requires permission|allow once|allow always|run this command\?/i

// Why bounded: answered dialogs and quoted prompt wording (agents grep this file and its specs) stay in the
// retained tail; only a dialog owning the screen bottom is live. Real Codex dialogs (trust, hooks review,
// update, exec approval) are 4-8 lines; the slack covers a wrapped command or a longer hook list.
const LIVE_PROMPT_TAIL_LINES = 12

function findTerminalWaitBlockedSignal(
  fullTail: string
): { reason: RuntimeTerminalWaitBlockedReason; index: number } | null {
  const windowStart = startOfLastNonBlankLines(fullTail, LIVE_PROMPT_TAIL_LINES)
  const normalized = windowStart === 0 ? fullTail : fullTail.slice(windowStart)
  // Why: one combined negative scan avoids a dozen searches when no prompt can match.
  if (!TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(normalized)) {
    return null
  }
  const signal = findBlockedSignalInLiveWindow(normalized)
  // Why: callers compare this index against ready-header indexes found over the full tail.
  return signal === null ? null : { reason: signal.reason, index: signal.index + windowStart }
}

function findBlockedSignalInLiveWindow(
  normalized: string
): { reason: RuntimeTerminalWaitBlockedReason; index: number } | null {
  const candidates: { reason: RuntimeTerminalWaitBlockedReason; index: number }[] = []
  const updateIndex = normalized.lastIndexOf('update available')
  if (updateIndex !== -1 && normalized.includes('press enter to continue', updateIndex)) {
    candidates.push({ reason: 'agent-update-prompt', index: updateIndex })
  }
  const cwdIndex = normalized.lastIndexOf('choose working directory to')
  if (cwdIndex !== -1 && normalized.includes('press enter to continue', cwdIndex)) {
    candidates.push({ reason: 'agent-cwd-prompt', index: cwdIndex })
  }
  const modelMigrationIndex = normalized.lastIndexOf('codex just got an upgrade')
  if (
    modelMigrationIndex !== -1 &&
    normalized.includes('press enter to continue', modelMigrationIndex)
  ) {
    candidates.push({ reason: 'codex-model-migration-prompt', index: modelMigrationIndex })
  }
  const hooksIndex = normalized.lastIndexOf('hooks need review')
  if (hooksIndex !== -1 && normalized.includes('press enter to confirm', hooksIndex)) {
    // Why neutral: this matcher never inspects the agent -- 'hooks need review' is not Codex-only wording.
    candidates.push({ reason: 'agent-hooks-review-prompt', index: hooksIndex })
  }
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
  const cursorApprovalIndex = findCursorApprovalPromptIndex(normalized)
  if (cursorApprovalIndex !== null) {
    candidates.push({ reason: 'agent-approval-prompt', index: cursorApprovalIndex })
  }
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
