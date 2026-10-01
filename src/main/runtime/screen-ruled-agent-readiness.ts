import type { TuiAgent } from '../../shared/tui-agent'
import { isAntigravityComposerReadyScreen } from './antigravity-terminal-readiness'
import { isClineComposerReadyScreen } from './cline-terminal-readiness'
import { isPrimeAgentComposerReadyScreen } from './prime-agent-terminal-readiness'

type ScreenReadyRule = (screenLines: readonly string[]) => boolean

/**
 * Agents whose live screen decides readiness. Each rule reads an idle composer off the grid,
 * which a folded text tail loses to cursor addressing. Why a clocked pane waits for quiet too:
 * the captures paint that composer for a moment mid-turn (a submit repaint, a spinner row
 * erased before its redraw) and, for Prime, just before its first-launch question.
 */
const SCREEN_READY_RULES: Partial<Record<TuiAgent, ScreenReadyRule>> = {
  antigravity: isAntigravityComposerReadyScreen,
  cline: isClineComposerReadyScreen,
  'prime-agent': isPrimeAgentComposerReadyScreen
}

export function getScreenReadyRule(agent: TuiAgent | null | undefined): ScreenReadyRule | null {
  return agent ? (SCREEN_READY_RULES[agent] ?? null) : null
}

/**
 * The agent's screen rule applied to its live screen, or null when it has no rule or no
 * trustworthy screen is readable. Why a verdict outranks every text rule: the screen is what
 * the folded text was copied from, and the text cannot see a picker or dialog covering it.
 */
export function readScreenRuledVerdict(
  agent: TuiAgent | null | undefined,
  readScreenLines: () => readonly string[] | null
): boolean | null {
  const rule = getScreenReadyRule(agent)
  const screenLines = rule ? readScreenLines() : null
  return rule && screenLines ? rule(screenLines) : null
}
