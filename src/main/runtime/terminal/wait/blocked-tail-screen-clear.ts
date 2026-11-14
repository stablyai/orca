import {
  joinedTerminalOrigins,
  terminalSupportQuery,
  lowercaseTerminalSupport,
  type TerminalContentOrigin
} from '../../../../shared/terminal/output/terminal-content-origin'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { findTerminalWaitBlockedSignal } from '../../agent-state-rules/blocked-text-layer'
import { evaluateAgentStateRules } from '../../agent-state-rules/agent-state-rules-engine'

/** Clear stale tail blockers only when the agent's screen rules prove its composer ready (#24187). */
export function screenClearsBlockedTail(
  agent: TuiAgent | null,
  screenLines: readonly string[],
  contentScope?: TerminalContentOrigin
): boolean {
  const joined = joinedTerminalOrigins(screenLines)
  const screen = lowercaseTerminalSupport(
    joined.text,
    terminalSupportQuery(joined.origins, contentScope)
  )
  if (
    findTerminalWaitBlockedSignal(screen.text, { wholeText: true, support: screen.query }) !== null
  ) {
    return false
  }
  return (
    evaluateAgentStateRules(agent, { readScreenLines: () => screenLines, contentScope })?.state ===
    'idle'
  )
}

/** Wait for quiet output before trusting a painted composer, then retire the stale stamp. */
export function readScreenClearingBlockedTail(args: {
  lastOutputAt: number | null
  quiescenceMs: number
  agent: () => TuiAgent | null
  readScreen: () => { lines: readonly string[] } | null
  contentScope?: TerminalContentOrigin
  clearStamp: () => void
}): string | null {
  if (args.lastOutputAt !== null && Date.now() - args.lastOutputAt < args.quiescenceMs) {
    return null
  }
  const screen = args.readScreen()
  if (!screen || !screenClearsBlockedTail(args.agent(), screen.lines, args.contentScope)) {
    return null
  }
  args.clearStamp()
  return screen.lines.join('\n')
}
