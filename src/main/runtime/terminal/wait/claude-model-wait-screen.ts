/** Reading terminal Claude's screen for a reply that may still be streaming. Claude fires no hook
 *  and writes no transcript line until a block ends (probe 2026-11-21, 2.1.330), but draws the reply
 *  as it arrives; its spinner, footer and a running tool's timer move whether or not a reply does. */

// Claude's spinner and status line: a glyph, then its words ("✻ Waiting for API response · …").
const SPINNER_LINE_RE = /^\s*[\u00B7\u2722\u2733\u2736\u273B\u273D*\u2726]\s+\S/u
const FOOTER_RE = /esc to interrupt|shift\+tab to cycle/i
const TOOL_RUNNING_RE = /\u23BF\s+Running\u2026/u
// A retry's countdown, should a Claude draw it as a status row below its spinner: it ticks while
// nothing arrives. Only such a row: a reply may use the same words.
const RETRY_COUNTDOWN_RE = /^\s*\u23BF\s.*(?:retrying in \d+|attempt \d+\/\d+)/iu
// Claude's own words for a request that has not answered: a stalled stream, or a retried error.
const MODEL_STATUS_RE = /Waiting for API response|retrying|API error/i

// The spinner's count of tokens received: the only sign of a tool call's input streaming, which
// Claude does not draw ("✻ Zigzagging… (10m 8s · ↓ 1.2k tokens)").
const RECEIVED_TOKENS_RE = /\u2193\s*([\d.,]+k?)\s*tokens/u

/** The screen without what moves when no reply does; the spinner keeps only its received tokens. */
export function claudeReplyScreen(lines: readonly string[]): string {
  return lines
    .flatMap((line) => {
      if (SPINNER_LINE_RE.test(line)) {
        const tokens = RECEIVED_TOKENS_RE.exec(line)?.[1]
        return tokens ? [`\u2193 ${tokens}`] : []
      }
      return FOOTER_RE.test(line) || TOOL_RUNNING_RE.test(line) || RETRY_COUNTDOWN_RE.test(line)
        ? []
        : [line.trimEnd()]
    })
    .join('\n')
}

// The line Claude leaves when a turn ends ("✻ Cooked for 8m 52s · done 1:31 AM").
const TURN_DONE_RE = /\u00B7\s+done\b/u

/** Claude's last status line says its turn is over: nothing is waiting on the model. */
export function claudeTurnDoneOnScreen(lines: readonly string[]): boolean {
  const status = lines.findLast((line) => SPINNER_LINE_RE.test(line))
  return status !== undefined && TURN_DONE_RE.test(status)
}

export function claudeToolRunsOnScreen(lines: readonly string[]): boolean {
  return lines.some((line) => TOOL_RUNNING_RE.test(line))
}

/** Claude's own status for the request (a stalled stream or a retry), else its spinner, else the
 *  last line it drew that is not chrome. */
export function claudeModelWaitLastSeen(lines: readonly string[]): string | undefined {
  const spinner = (line: string) => SPINNER_LINE_RE.test(line)
  const status =
    lines.findLast((line) => spinner(line) && MODEL_STATUS_RE.test(line)) ?? lines.findLast(spinner)
  if (status) {
    return status.replace(/^\s*[\u00B7\u2722\u2733\u2736\u273B\u273D*\u2726]\s+/u, '').trim()
  }
  return lines.findLast((line) => /[\p{L}\p{N}]/u.test(line) && !FOOTER_RE.test(line))?.trim()
}
