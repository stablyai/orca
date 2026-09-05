// Unit 5: ask view-model (spec S7/S8) — title + body, option strip `> 1  2  3  Enter  Esc`
// with a `>` cursor. NotificationInboxEntry carries no option count (v1 sends raw digits
// without parsing the agent's prompt), so the strip always shows DEFAULT_ASK_OPTION_COUNT
// digits; the NavContext builder should return this same constant for askOptionCount so the
// reducer's cursor bound matches what's rendered here.
import { GLYPH_CURSOR_PREFIX } from '../hud/hud-glyphs'
import type { HudScreenPage } from '../hud/hud-page-spec'
import { paginateHudBody } from '../hud/hud-text-pagination'
import { topFrame } from '../navigation/hud-navigation-frames'
import type { ScreenFrame } from '../navigation/nav-contract'
import type { HudState } from '../state/hud-store'

export const DEFAULT_ASK_OPTION_COUNT = 3

export function renderAskScreen(state: HudState): Extract<HudScreenPage, { layout: 'text' }> {
  const frame = topFrame(state.nav) as Extract<ScreenFrame, { screen: 'ask' }>
  const entry = state.inbox.entries.find((e) => e.notificationId === frame.notificationId)
  const title = entry?.title ?? 'Needs input'
  const [firstBodyPage = ''] = entry ? paginateHudBody(entry.body.split('\n')) : ['']
  const strip = buildOptionStrip(frame.selectedOption, DEFAULT_ASK_OPTION_COUNT)

  return {
    layout: 'text',
    header: `Orca · ${title}`,
    body: `${firstBodyPage}\n${strip}`,
    footer: askFooter(state, entry?.worktreeId)
  }
}

// Optimistic "answered" footer (spec S7): shows right after sendAskAnswer; once the dashboard
// polls again (fetchedAt advances past sentAt) and the worktree is still `permission`, flips to
// a "still waiting" nudge instead of silently staying "answered".
function askFooter(state: HudState, worktreeId: string | undefined): string {
  const answered = state.askAnswered
  if (!answered || answered.worktreeId !== worktreeId) {
    return 'click=send  2tap=back'
  }
  const worktree = state.dashboard.rows.find((r) => r.worktreeId === worktreeId)
  const polledSinceAnswer = state.dashboard.fetchedAt >= answered.sentAt
  if (polledSinceAnswer && worktree?.status === 'permission') {
    return 'still waiting — check phone'
  }
  return 'answered ✓  2tap=back'
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
