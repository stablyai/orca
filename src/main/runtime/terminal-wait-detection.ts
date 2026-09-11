import {
  detectAgentStatusFromTitle,
  isOpenCodeNativeTitle,
  type AgentStatus
} from '../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import {
  isTerminalWaitWhitespace,
  startOfLastLines,
  startOfLastNonBlankLines
} from './terminal-wait-tail-window'

const EXPLICIT_IDLE_TITLE_RE = /(^|\s)(ready|idle|done)(\s|$|[.!?])/i
const CLAUDE_IDLE_PREFIX = '\u2733'
const GEMINI_IDLE_PREFIX = '\u25c7'
const PI_IDLE_PREFIX = '\u03c0 - '

export function detectExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
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

export function isKnownReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  const readyIndex = findKnownReadyPromptIndex(normalized)
  if (readyIndex === null) {
    return false
  }
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  if (blockedSignal !== null && blockedSignal.index > readyIndex) {
    return false
  }
  return true
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
    findCursorActivePromptIndex(normalized)
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

function findCodexReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('openai codex')
  if (headerIndex === -1) {
    return null
  }
  const readySegment = normalized.slice(headerIndex)
  // Why: Codex prints permissions only in YOLO mode; the stable ready header is OpenAI Codex + model + directory.
  return readySegment.includes('model:') && readySegment.includes('directory:') ? headerIndex : null
}

function findAntigravityReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('antigravity cli')
  if (headerIndex === -1) {
    return null
  }
  let lineStart = headerIndex
  let modelIndex: number | null = null
  let promptIndex: number | null = null

  // Why: ready previews can include echoed paste after the header; scan line bounds directly instead of splitting the whole tail.
  for (let cursor = headerIndex; cursor <= normalized.length; cursor += 1) {
    if (cursor < normalized.length && normalized.charCodeAt(cursor) !== 10) {
      continue
    }
    let trimmedStart = lineStart
    let trimmedEnd = cursor
    while (trimmedStart < trimmedEnd && isTerminalWaitWhitespace(normalized, trimmedStart)) {
      trimmedStart += 1
    }
    while (trimmedEnd > trimmedStart && isTerminalWaitWhitespace(normalized, trimmedEnd - 1)) {
      trimmedEnd -= 1
    }
    if (lineStart > headerIndex && trimmedStart < trimmedEnd) {
      if (modelIndex === null && normalized.startsWith('gemini', trimmedStart)) {
        modelIndex = trimmedStart
      }
      if (
        promptIndex === null &&
        trimmedEnd - trimmedStart === 1 &&
        normalized.charCodeAt(trimmedStart) === 62
      ) {
        promptIndex = trimmedStart
      }
    }
    lineStart = cursor + 1
  }

  return modelIndex !== null && promptIndex !== null ? Math.max(modelIndex, promptIndex) : null
}

export const TERMINAL_WAIT_BLOCKED_SENTINEL_RE =
  /update available|choose working directory to|codex just got an upgrade|hooks need review|do you trust|trust this|trusted workspace|press enter to (?:confirm|continue|view|insert)|press t to trust|permission (?:needed|required)|requires permission|allow once|allow always|apply this change\?|run this command\?/i

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
  const liveWindowSignal = TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(normalized)
    ? findBlockedSignalInLiveWindow(normalized)
    : null
  const genericSignal =
    liveWindowSignal === null
      ? null
      : { reason: liveWindowSignal.reason, index: liveWindowSignal.index + windowStart }
  // fx command bodies can wrap beyond the generic bounded window. Its structural
  // footer and dialog boundaries keep the full-tail scan tied to the live screen.
  const fxApprovalIndex = findFxApprovalPromptIndex(fullTail)
  const fxSignal =
    fxApprovalIndex === null
      ? null
      : ({ reason: 'agent-approval-prompt', index: fxApprovalIndex } as const)
  if (genericSignal === null) {
    return fxSignal
  }
  return fxSignal !== null && fxSignal.index > genericSignal.index ? fxSignal : genericSignal
}

const FX_DIALOG_BOUNDARY_RE = /[─━═╌╍┄┅┈┉]{3,}/g
const FX_SELECTABLE_CHOICE_RE = /(\d+)(?:\.|\s{2,})\s*\S/g

type FxDialogBoundary = { index: number }

function findLastFxDialogBoundaryBefore(
  normalized: string,
  beforeIndex: number
): FxDialogBoundary | null {
  let lastBoundary: FxDialogBoundary | null = null
  for (const match of normalized.slice(0, beforeIndex).matchAll(FX_DIALOG_BOUNDARY_RE)) {
    lastBoundary = { index: match.index }
  }
  return lastBoundary
}

function findLastFxPermissionHeaderBefore(normalized: string, beforeIndex: number): number | null {
  const permissionIndex = normalized.lastIndexOf('permission needed', beforeIndex)
  if (permissionIndex === -1) {
    return null
  }
  const lineStart = normalized.lastIndexOf('\n', permissionIndex) + 1
  const linePrefix = normalized.slice(lineStart, permissionIndex)
  const hasHeaderIndent =
    linePrefix.trim() === '' ||
    /^\s{2}$/.test(normalized.slice(permissionIndex - 2, permissionIndex))
  const hasHeaderSeparator = /^\s*·/.test(
    normalized.slice(permissionIndex + 'permission needed'.length, beforeIndex)
  )
  return hasHeaderIndent && hasHeaderSeparator ? permissionIndex : null
}

function findFxApprovalPromptIndex(normalized: string): number | null {
  const liveTail = normalized.trimEnd()
  const cancelIndex = liveTail.lastIndexOf('esc cancel')
  if (cancelIndex === -1 || cancelIndex + 'esc cancel'.length !== liveTail.length) {
    return null
  }
  const confirmIndex = liveTail.lastIndexOf('enter confirm', cancelIndex)
  const chooseIndex = liveTail.lastIndexOf('choose now', confirmIndex)
  if (chooseIndex === -1 || confirmIndex === -1) {
    return null
  }
  const footerBoundary = findLastFxDialogBoundaryBefore(liveTail, chooseIndex)
  if (footerBoundary === null) {
    return null
  }
  const permissionIndex = findLastFxPermissionHeaderBefore(liveTail, footerBoundary.index)
  if (permissionIndex === null) {
    return null
  }
  const dialogBoundary = findLastFxDialogBoundaryBefore(liveTail, permissionIndex)
  if (dialogBoundary === null) {
    return null
  }
  const dialogBody = liveTail.slice(
    permissionIndex + 'permission needed'.length,
    footerBoundary.index
  )
  const choiceNumbers = new Set(
    [...dialogBody.matchAll(FX_SELECTABLE_CHOICE_RE)].map((match) => Number(match[1]))
  )
  return choiceNumbers.has(1) && choiceNumbers.has(2) ? permissionIndex : null
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
