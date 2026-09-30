import { isQoderComposerReady } from './qoder-terminal-readiness'
import { memoizeTitleClassification } from '../../shared/terminal-title-classification-memo'
import {
  detectAgentStatusFromTitle,
  isOpenCodeNativeTitle,
  type AgentStatus
} from '../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { getPiStateTitleStatus } from '../../shared/pi-state-title-marker'
import { findAntigravityReadyPromptIndex } from './antigravity-terminal-readiness'
import {
  findCodexHeaderIndex,
  findCodexScreenReadyPromptIndex,
  isCodexComposerReadyScreen,
  isCodexProvisionalStartupText
} from './codex-terminal-readiness'
import { findStartupDialogBlockedSignals } from './startup-dialog-blocked-signals'
import { startOfLastLines, startOfLastNonBlankLines } from './terminal-wait-tail-window'

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
    title.startsWith(PI_IDLE_PREFIX) ||
    getPiStateTitleStatus(title) === 'idle'
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
 * The ready-prompt text rules for a pane about to take input. Unlike isKnownReadyPromptPreview
 * (agent presence), Codex's provisional startup header does not count: 0.157 discards input typed
 * behind it while its daemon starts.
 */
export function isKnownReadyPromptSettled(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isReadyPromptSettled(normalized, findKnownReadyPromptIndex(normalized))
}

function isReadyPromptSettled(normalized: string, readyIndex: number | null): boolean {
  return (
    isReadyPromptUnblocked(normalized, readyIndex) && !isCodexProvisionalStartupText(normalized)
  )
}

/**
 * Tier 1 body evidence for every tui-idle site. `readScreenLines` yields the live emulator's
 * visible grid, or null when the runtime has no trustworthy one.
 *
 * Why not for a clocked Codex pane: its header stays up through every turn, so it proves only
 * that Codex started; isQuietReadyScreenBody holds it to quiescence instead.
 * Why a clockless pane keeps it: quiescence needs an output clock, which a restored pane lacks.
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
  if (agent === 'codex' && hasOutputClock) {
    return false
  }
  if (isKnownReadyPromptSettled(waitText)) {
    return true
  }
  // Why the agent gate: another agent's screen can merely mention "OpenAI Codex".
  if (agent !== null && agent !== 'codex') {
    return false
  }
  const screen = readScreen(readScreenLines)
  return screen !== null && isCodexScreenHeaderReady(screen)
}

/**
 * Tier 1b body evidence: a ready screen from an agent with no title rest signal. Unlike tier 1
 * it only proves the TUI is up, so the ranking holds it to quiescence.
 * Why codex panes only: a `cat`ed transcript or pager in an unknown pane can show the composer.
 */
export function isQuietReadyScreenBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null
): boolean {
  if (agent === 'codex') {
    const screen = readScreen(readScreenLines)
    if (
      screen !== null &&
      (isCodexComposerReadyScreen(screen) || isCodexScreenHeaderReady(screen))
    ) {
      return true
    }
    // Why the provisional veto here too: a daemon start can stay quiet past the quiescence window.
    const normalized = waitText.toLowerCase()
    return isReadyPromptSettled(normalized, findCodexReadyPromptIndex(normalized))
  }
  return (agent === null || agent === 'muse') && isMuseReadyPromptPreview(waitText)
}

/**
 * Why the screen: Codex repaints its 0.150-0.157 header by cell diff (`ESC[5;3Hdir
 * ESC[5;7Hctory:`), which only a grid reassembles — the line-folded wait text reads `dirctory:`.
 * Why it can only add readiness: a grid out of step with the PTY (size mismatch, resize
 * mid-paint) garbles the header, so the text rule keeps every verdict it gives on its own.
 */
function isCodexScreenHeaderReady(screen: string): boolean {
  return isReadyPromptUnblocked(screen, findCodexScreenReadyPromptIndex(screen))
}

function readScreen(readScreenLines: () => readonly string[] | null): string | null {
  return readScreenLines()?.join('\n').toLowerCase() ?? null
}

function isReadyPromptUnblocked(normalized: string, readyIndex: number | null): boolean {
  if (readyIndex === null) {
    return false
  }
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  return blockedSignal === null || blockedSignal.index <= readyIndex
}

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
    findCodexHeaderIndex(normalized),
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

function findCodexReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('openai codex')
  if (headerIndex === -1) {
    return null
  }
  const readySegment = normalized.slice(headerIndex)
  // Why: Codex prints permissions only in YOLO mode; the stable ready header is OpenAI Codex + model + directory.
  return readySegment.includes('model:') && readySegment.includes('directory:') ? headerIndex : null
}

export const TERMINAL_WAIT_BLOCKED_SENTINEL_RE =
  /update available|choose working directory to|codex just got an upgrade|available\s*·|esc\s*skip|enter\s*confirm\s*·|enter\/esc\s*(?:continue|confirm)|hooks need review|do you trust|trust this|trusted workspace|press enter to (?:confirm|continue|view|insert)|press t to trust|permission required|requires permission|allow once|allow always|run this command\?/i

// Why text at all: cursor-agent has no approval hook, so the key-bound menu is the only authority.
const CURSOR_APPROVAL_CHOICE_MARKERS = [
  'run (once)',
  'to allowlist?',
  'run everything',
  'skip & tell the agent'
]
// Why bounded: an answered menu remains in scrollback; only a dialog owning the screen bottom is live.
const CURSOR_APPROVAL_TAIL_LINES = 8

function findCursorApprovalPromptIndex(normalized: string): number | null {
  const windowStart = startOfLastLines(normalized, CURSOR_APPROVAL_TAIL_LINES)
  const tail = normalized.slice(windowStart)
  if (!tail.includes('run this command?')) {
    return null
  }
  const lines = tail.split('\n')
  while (lines.length > 0 && lines.at(-1)?.trim() === '') {
    lines.pop()
  }
  let matchedLines = 0
  let lastChoiceLine = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (!isCursorApprovalChoiceLine(lines[index])) {
      continue
    }
    matchedLines += 1
    lastChoiceLine = index
  }
  return matchedLines >= 2 && lastChoiceLine === lines.length - 1
    ? windowStart + tail.lastIndexOf('run this command?')
    : null
}

// Why the trailing key: narration can repeat the menu wording, but it does not end in a selectable key.
const CURSOR_APPROVAL_CHOICE_KEY_RE =
  /\((?:shift\+tab|ctrl\+[a-z]|esc(?: or [a-z])*|tab|enter|return|space|[a-z]|[\u21b5\u21e7\u21b9\u238b\u23ce]{1,3})\)\s*$/

function isCursorApprovalChoiceLine(line: string): boolean {
  return (
    CURSOR_APPROVAL_CHOICE_KEY_RE.test(line) &&
    CURSOR_APPROVAL_CHOICE_MARKERS.some((marker) => line.includes(marker))
  )
}

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
