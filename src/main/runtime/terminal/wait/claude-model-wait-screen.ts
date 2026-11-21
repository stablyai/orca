/** Reading terminal Claude's screen for a reply that may still be streaming. Claude fires no hook
 *  and writes no transcript line until a block ends (probe 2026-11-21, 2.1.330), but draws the reply
 *  as it arrives; its spinner, footer and a running tool's timer move whether or not a reply does. */

// Claude's spinner and status line: a glyph, then its words ("✻ Waiting for API response · …").
const SPINNER_LINE_RE = /^\s*[·✢✳✶✻✽*✦]\s+\S/u
const FOOTER_RE = /esc to interrupt|shift\+tab to cycle/i
const TOOL_RUNNING_RE = /⎿\s+Running…/u
// Claude's own words for a request that has not answered: a stalled stream, or a retried error.
const MODEL_STATUS_RE = /Waiting for API response|retrying|API error/i

/** The screen without what moves when no reply does. */
export function claudeReplyScreen(lines: readonly string[]): string {
  return lines
    .filter(
      (line) => !SPINNER_LINE_RE.test(line) && !FOOTER_RE.test(line) && !TOOL_RUNNING_RE.test(line)
    )
    .map((line) => line.trimEnd())
    .join('\n')
}

export function claudeToolRunsOnScreen(lines: readonly string[]): boolean {
  return lines.some((line) => TOOL_RUNNING_RE.test(line))
}

/** Claude's own status for the request, else the last line of the screen that is not chrome. */
export function claudeModelWaitLastSeen(lines: readonly string[]): string | undefined {
  const status = lines.findLast((line) => SPINNER_LINE_RE.test(line) && MODEL_STATUS_RE.test(line))
  if (status) {
    return status.replace(/^\s*[·✢✳✶✻✽*✦]\s+/u, '').trim()
  }
  return lines
    .findLast(
      (line) => /[\p{L}\p{N}]/u.test(line) && !FOOTER_RE.test(line) && !SPINNER_LINE_RE.test(line)
    )
    ?.trim()
}
