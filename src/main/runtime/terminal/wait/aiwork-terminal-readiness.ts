import type { RuledScreen } from './screen-input-veto'

// Footer keys stay untranslated and are cut from the end on narrow panes, so the leading key decides.
// Approval: `┃  enter confirm current option · esc …`; question: `┃  ↑↓ Switch options · enter Submit · …`,
// with `enter Next`, `enter Confirm` or `enter Review` and more keys ahead of it in multi-question boxes.
const GATE_FOOTER_RE = /^\s*┃\s+(?:\S.*·\s+)?enter\s+\S/u
// Plan review: `│  Run(a)  Revise(m)  Discard(r)  Copy(y)  Close(Esc)`, labels translated, keys not.
// Either half counts: the floating panel paints its footer from the right as it opens, and leaves
// the screen beneath visible left of its border.
const PLAN_REVIEW_FOOTER_RE = /\S\(a\)\s+\S+\(m\)|\S\(r\)\s+\S+\(y\)/u
const FOOTER_REGION_LINES = 16

/** AiWork's approval, question and plan-review screens take Enter or single letters as answers. */
export function isAiworkGateScreen(screen: RuledScreen): boolean {
  return screen.lines
    .slice(-FOOTER_REGION_LINES)
    .some((line) => GATE_FOOTER_RE.test(line) || PLAN_REVIEW_FOOTER_RE.test(line))
}
