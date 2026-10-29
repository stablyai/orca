import type { TuiAgent } from '../../shared/tui-agent'
import { findTerminalWaitBlockedSignal } from './agent-state-rules/blocked-text-layer'
import { evaluateAgentStateRules } from './agent-state-rules/agent-state-rules-engine'

/** Clear stale tail blockers only when the agent's screen rules prove its composer ready (#24187). */
export function screenClearsBlockedTail(
  agent: TuiAgent | null,
  screenLines: readonly string[]
): boolean {
  const screen = screenLines.join('\n').toLowerCase()
  if (findTerminalWaitBlockedSignal(screen, { wholeText: true }) !== null) {
    return false
  }
  return evaluateAgentStateRules(agent, { readScreenLines: () => screenLines })?.state === 'idle'
}
