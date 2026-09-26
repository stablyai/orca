import type { UsageLimitStallReason } from '../../shared/agent-auto-resume-types'
import { USAGE_LIMIT_RESET_LABEL_SOURCE } from '../../shared/usage-limit-menu-selection'
import { extractClaudePtyResetMetadata } from '../rate-limits/claude-pty-reset-parser'

export type UsageLimitStallSignal = {
  reason: UsageLimitStallReason
  /** Offset of the match in the scanned (lowercased) tail. Used to decide when
   *  an appended chunk introduced a *newer* stall than the previous tail held. */
  index: number
}

// Why: match the wait-for-reset menu option. `\s*` between tokens tolerates the
// space-collapsed render the PTY sometimes emits ("Stopandwaitforlimittoreset")
// as well as normal spacing. The reset option is the strongest menu signal.
// The `g` flag lets latestMatchIndex scan for every occurrence via matchAll.
const MENU_PATTERNS = [
  // Shared source with the row picker in usage-limit-menu-selection.ts: if the
  // two wordings drift, detection fires and selection refuses forever.
  new RegExp(USAGE_LIMIT_RESET_LABEL_SOURCE, 'g'),
  // The admin option co-occurs with the reset option; matching it too keeps
  // detection alive if the reset line scrolls just out of the retained tail.
  /ask\s*your\s*admin\s*for\s*more\s*usage/g
]

// Why: the idle banner states the agent is blocked BY a limit. Requiring
// "hit/reached your … limit" (or "… limit reached") keeps this specific enough
// to skip the /usage table and the "Show plan usage limits" command palette,
// which also contain the word "limit" and even "resets" lines. Whitespace is
// tolerant for the same collapsed-render reason as the menu patterns.
const BANNER_PATTERNS = [
  // Claude Code stops re-arming its own auto-continue after two consecutive
  // hits ("Automatic continue stopped after repeated usage-limit hits ·
  // /rate-limit-options to try again") and then just sits there. That hand-off
  // is exactly where the watcher takes over, so it reads as an ordinary banner:
  // no reset time in the text, so the provider's resetsAt or the unknown-reset
  // delay decides when to resend.
  /automatic\s*continue\s*stopped/g,
  // "monthly spend" is in the list because Claude Code mislabels a 5-hour-limit
  // hit as "You've hit your monthly spend limit" on accounts with extra usage
  // disabled (observed 2026-08-27, cc_cli_limit_message). The banner carries no
  // reset time, so the service falls back to its unknown-reset delay — which is
  // right for the real 5h limit hiding behind the wrong label.
  /(?:hit|hitting|reached|reaching)\s*your\s*(?:(?:5-?\s*hour|5h|weekly|session|usage|rate|monthly|spend)\s*)*limit/g,
  /(?:session|usage|weekly|rate)\s*limit\s*(?:has\s*been\s*)?reached/g
]

// Why: Claude Code 2.1.234+ waits out a usage limit in-session and prints its
// own countdown ("Usage limit reached · continuing automatically at 3:45pm ·
// esc to cancel"). The banner half of that line matches BANNER_PATTERNS, so
// without this the watcher arms on a pane the CLI is already handling and
// resends `continue` into a session that just auto-continued itself.
const CLI_WAITING_PATTERNS = [/continuing\s*automatically/g]

// Why: the degraded end of that same feature. After a long sleep the CLI stops
// counting down and waits for a keypress instead ("Your usage limit has reset ·
// press enter to continue"). The limit is over and one Enter is the whole fix,
// but the CLI only asks once and nobody is at the keyboard.
const RESET_PROMPT_PATTERNS = [/limit\s*has\s*reset/g]

// Ordered so a tie goes to the earlier entry: menu before banner preserves the
// long-standing "a chooser rendered at the same offset wins" behaviour, and the
// two CLI-owned states are last because they only ever appear on their own line.
const SIGNAL_PATTERNS: { reason: UsageLimitStallReason; patterns: RegExp[] }[] = [
  { reason: 'usage-limit-menu', patterns: MENU_PATTERNS },
  { reason: 'usage-limit-banner', patterns: BANNER_PATTERNS },
  { reason: 'usage-limit-cli-waiting', patterns: CLI_WAITING_PATTERNS },
  { reason: 'usage-limit-reset-prompt', patterns: RESET_PROMPT_PATTERNS }
]

// Why: return the LATEST (greatest-offset) match, mirroring the blocked-reason
// signal's lastIndexOf. Retained PTY tails keep earlier output, so a first-match
// index would stay pinned to a stale banner/menu and the caller's "did this
// chunk add a *newer* stall?" comparison could never re-arm on a second event.
// matchAll clones the (global) regex, so the shared module-level patterns are
// safe to reuse across calls.
function latestMatchIndex(text: string, patterns: RegExp[]): number | null {
  let best: number | null = null
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined && (best === null || match.index > best)) {
        best = match.index
      }
    }
  }
  return best
}

/**
 * Detect whether an agent CLI is stalled on a provider usage limit.
 *
 * @param normalizedTail the retained PTY tail, ANSI-stripped and lowercased
 *   (the same text `findActionableTerminalWaitBlockedSignal` scans).
 *
 * The LOWEST on screen wins, because the tail is chronological: a chooser
 * rendered under a banner is the state the agent is parked in, and a banner
 * printed under a dismissed chooser is the newer event. Menu-always-wins made
 * the second act of the menu path undetectable — after the watcher presses
 * Enter, the chooser text lingers in the retained tail, so the banner Claude
 * prints next always scored behind it and no newer stall was ever recorded.
 * The same ordering is what lets the CLI's own auto-continue line supersede the
 * banner it is printed beside, and a fresh limit supersede a cancelled wait.
 * The returned index is that match's offset, so the caller's "did this chunk add
 * a newer stall?" comparison stays monotonic.
 */
export function detectUsageLimitStall(normalizedTail: string): UsageLimitStallSignal | null {
  let latest: UsageLimitStallSignal | null = null
  for (const { reason, patterns } of SIGNAL_PATTERNS) {
    const index = latestMatchIndex(normalizedTail, patterns)
    if (index !== null && (latest === null || index > latest.index)) {
      latest = { reason, index }
    }
  }
  return latest
}

const BANNER_LABEL_RE =
  /(?:session|usage|weekly|rate|5-?\s*hour|5h)\s*limit|hit\s*your|limit\s*reset/i
// Claude's "/upgrade to increase your usage limit." hint has no reset
const SLASH_COMMAND_HINT_RE = /^\s*\//

// Why: Codex phrases its reset as "…or try again at Apr 23rd, 2026 10:42 AM.",
// which the Claude "resets …" parser doesn't recognize. Match the date after
// the retry marker; global so we can select the LAST occurrence (see below).
const CODEX_RETRY_AT_RE =
  /or\s+try\s+again\s+at\s+([A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))\.?/gi
const DAY_ORDINAL_RE = /(\d{1,2})(?:st|nd|rd|th)/i

function parseLatestCodexRetryAt(text: string): number | null {
  // Anchor to the NEWEST banner: two limit banners can coexist in the retained
  // tail (limit → resume → limit again), and inheriting the older reset would
  // schedule a resume at a past time and fire early.
  let latest: RegExpMatchArray | null = null
  for (const match of text.matchAll(CODEX_RETRY_AT_RE)) {
    latest = match
  }
  if (!latest) {
    return null
  }
  // "Apr 23rd, 2026 10:42 AM" -> "Apr 23, 2026 10:42 AM" so Date can parse it.
  // The text carries no timezone, so this resolves in the runtime host's local
  // zone; the service prefers the provider's structured resets_at when present.
  const normalized = latest[1].replace(DAY_ORDINAL_RE, '$1')
  const timestamp = new Date(normalized).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

/**
 * Parse the reset timestamp out of a usage-limit banner's tail. Handles Codex's
 * "or try again at <date>" and Claude's "resets 3:50pm" / "resets Jan 5 at 4pm"
 * / relative "3h 20m" (with time zones). Returns null when the banner carries
 * no parseable reset (e.g. the menu, which never prints a time).
 *
 * Anchored to the newest banner in the tail so a stale earlier banner can't
 * supply an old reset time.
 */
export function extractUsageLimitResetAt(tailLines: string[]): number | null {
  const codexResetAt = parseLatestCodexRetryAt(tailLines.join('\n'))
  if (codexResetAt !== null) {
    return codexResetAt
  }
  // Claude: scan only from the last banner-label line so the parser reads the
  // newest banner's reset rather than the first one it finds top-down.
  let lastLabelIndex = -1
  for (let i = 0; i < tailLines.length; i++) {
    if (BANNER_LABEL_RE.test(tailLines[i]) && !SLASH_COMMAND_HINT_RE.test(tailLines[i])) {
      lastLabelIndex = i
    }
  }
  const scopedLines = lastLabelIndex >= 0 ? tailLines.slice(lastLabelIndex) : tailLines
  return extractClaudePtyResetMetadata(
    scopedLines,
    (line) => BANNER_LABEL_RE.test(line),
    () => false
  ).resetsAt
}
