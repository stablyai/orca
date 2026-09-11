import { startOfLastLines } from '../../shared/terminal-wait-tail-window'

/** cursor-agent's key-bound exec-approval menu, which no hook reports. */
// Why text at all: cursor-agent has no approval hook, so the key-bound menu is the only authority.
const CURSOR_APPROVAL_CHOICE_MARKERS = [
  'run (once)',
  'to allowlist?',
  'run everything',
  'skip & tell the agent'
]
// Why bounded: an answered menu remains in scrollback; only a dialog owning the screen bottom is live.
const CURSOR_APPROVAL_TAIL_LINES = 8

export function findCursorApprovalPromptIndex(normalized: string): number | null {
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
