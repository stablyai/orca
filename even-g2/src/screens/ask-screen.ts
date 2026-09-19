// Unit 5: ask view-model (spec S7/S8) — title + body, option strip `> 1  2  3  Enter  Esc`
// with a `>` cursor. NotificationInboxEntry carries no option count (v1 sends raw digits
// without parsing the agent's prompt), so the strip always shows DEFAULT_ASK_OPTION_COUNT
// digits; the NavContext builder should return this same constant for askOptionCount so the
// reducer's cursor bound matches what's rendered here.
import { GLYPH_CURSOR_PREFIX } from '../hud/hud-glyphs'
import type { HudScreenPage } from '../hud/hud-page-spec'
import { DEFAULT_MAX_CHARS_PER_PAGE, paginateHudBody } from '../hud/hud-text-pagination'
import { topFrame } from '../navigation/hud-navigation-frames'
import type { ScreenFrame } from '../navigation/nav-contract'
import type { HudState } from '../state/hud-store'

export const DEFAULT_ASK_OPTION_COUNT = 3

const DEFAULT_ASK_FOOTER = 'scroll=choose  click=send  2tap=back'

// HIGH #5: pre-wraps the body to this conservative glyph width before pagination, so a single
// unbroken long line (e.g. a 1200-char prompt with no newlines) is counted as the many visual
// rows it will actually render as, instead of surviving pagination as one giant unsplit "line"
// whose tail — where the option strip lives — buildHudPage's hard BODY_MAX_CHARS(1000) slice
// would otherwise cut off silently.
const ASK_BODY_MAX_GLYPHS_PER_LINE = 48

// Findings #1/#8 (partial, honest — full option-text parsing is v2): the strip is shown as
// numbered slots without claiming what each one means, since v1 sends raw digits without
// parsing the agent's actual prompt. When the last resolution/send attempt came back
// failed/unresolved, the strip is replaced entirely — sending would be guessing which terminal
// (or whether it even landed), so the UI must say so rather than show cursor-able options that
// don't actually work right now.
const OPTIONS_UNAVAILABLE_TEXT = 'Options unavailable — check phone'

export function renderAskScreen(state: HudState): Extract<HudScreenPage, { layout: 'text' }> {
  const frame = topFrame(state.nav) as Extract<ScreenFrame, { screen: 'ask' }>
  const entry = state.inbox.entries.find((e) => e.notificationId === frame.notificationId)
  const title = entry?.title ?? 'Needs input'
  // HIGH #3: an interaction only applies to THIS screen's exact host+prompt — a stale one left
  // over from a different host or a superseded ask must never be rendered here.
  const interaction =
    state.askInteraction !== null &&
    state.askInteraction.hostId === frame.hostId &&
    state.askInteraction.notificationId === frame.notificationId
      ? state.askInteraction
      : null
  const optionsUnavailable =
    interaction !== null &&
    (interaction.phase === 'failed' ||
      interaction.phase === 'unresolved' ||
      interaction.phase === 'stalled')
  const optionArea = optionsUnavailable
    ? OPTIONS_UNAVAILABLE_TEXT
    : buildOptionStrip(frame.selectedOption, DEFAULT_ASK_OPTION_COUNT)

  // Reserve a line + its chars for the strip appended below the body, so a full first page
  // never pushes the strip past the 216px text region (only the first body page is ever
  // shown — the rest, if any, is surfaced via the footer's truncation indicator instead of a
  // second scroll axis, since scroll on this screen already moves the option cursor).
  // Finding #1: body is always the notification's own text (the real human summary) — never a
  // guess at option semantics. A synthesized ask (finding #14 — blocked with no notification
  // yet) has no entry at all, so say so plainly instead of rendering an empty page.
  // HIGH #5: maxGlyphsPerLine force-wraps a long unbroken line before the char/line budgets are
  // applied — see ASK_BODY_MAX_GLYPHS_PER_LINE's comment — so the strip below is never at risk
  // of being sliced off by buildHudPage's separate, larger BODY_MAX_CHARS truncation.
  const bodyText = entry?.body ?? 'Waiting on input — no details yet'
  const bodyPages = paginateHudBody(bodyText.split('\n'), {
    maxCharsPerPage: DEFAULT_MAX_CHARS_PER_PAGE - optionArea.length - 1,
    maxGlyphsPerLine: ASK_BODY_MAX_GLYPHS_PER_LINE,
    reservedLines: 1
  })
  const firstBodyPage = bodyPages[0] ?? ''
  const truncated = bodyPages.length > 1

  return {
    layout: 'text',
    header: `Orca · ${title}`,
    body: `${firstBodyPage}\n${optionArea}`,
    footer: askFooter(interaction, truncated)
  }
}

// HIGH #2/#3/#6: the footer now renders HudState.askInteraction's phase directly — set by
// nav-ports.ts's sendAskAnswer/scheduleConfirmationPoll — instead of only ever an optimistic
// "answered ✓" derived from a bare sentAt timestamp. `interaction` is already pre-filtered to
// this exact host+prompt by the caller (HIGH #3).
function askFooter(interaction: HudState['askInteraction'], truncated: boolean): string {
  const truncatedMark = truncated ? '  ⋯more' : ''
  if (!interaction) {
    return `${DEFAULT_ASK_FOOTER}${truncatedMark}`
  }
  switch (interaction.phase) {
    case 'sending':
      return 'Sending…'
    case 'checking':
      return 'Sent — checking…'
    case 'stalled':
      return 'Sent — check phone'
    case 'failed':
      return 'Not sent — click to retry'
    case 'unresolved':
      return 'Delivery unknown — check phone'
    case 'answered':
      return 'answered ✓  2tap=back'
    case 'idle':
    default:
      return `${DEFAULT_ASK_FOOTER}${truncatedMark}`
  }
}

function buildOptionStrip(selectedOption: number, optionCount: number): string {
  const labels: string[] = []
  for (let i = 0; i < optionCount; i++) {
    labels.push(String(i + 1))
  }
  labels.push('Enter', 'Esc')

  return labels
    .map((label, i) => `${i === selectedOption ? GLYPH_CURSOR_PREFIX : ' '} ${label}`)
    .join('  ')
}
