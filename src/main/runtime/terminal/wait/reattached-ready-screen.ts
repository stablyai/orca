import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  evaluateAgentStateRules,
  readsTrustedScreen
} from '../../agent-state-rules/agent-state-rules-engine'
import type { RuledScreen } from './screen-input-veto'
import { TUI_IDLE_QUIESCENCE_MS } from './terminal-idle-policy'

export type ReattachedReadyScreen = { kind: 'idle' } | { kind: 'recheck'; afterMs: number } | null

/** Whether a reattached agent's own strong ready rule holds on its trusted grid. Only agents whose
 *  rules read that grid qualify; a grid not yet readable or a quiet window still owed asks for one
 *  recheck, and anything else (busy, draft, dialog, unknown screen) answers nothing. */
export function readReattachedReadyScreen(
  agent: TerminalAgent | null,
  screen: RuledScreen | null,
  outputClockAt: number | null
): ReattachedReadyScreen {
  if (!isTuiAgent(agent) || !readsTrustedScreen(agent)) {
    return null
  }
  if (!screen) {
    return { kind: 'recheck', afterMs: TUI_IDLE_QUIESCENCE_MS }
  }
  const verdict = evaluateAgentStateRules(agent, { readScreenLines: () => screen.lines })
  if (verdict?.state !== 'idle' || verdict.strength !== 'strong') {
    return null
  }
  const quietRemainingMs =
    outputClockAt === null
      ? TUI_IDLE_QUIESCENCE_MS
      : TUI_IDLE_QUIESCENCE_MS - (Date.now() - outputClockAt)
  return !verdict.requiresQuiet || quietRemainingMs <= 0
    ? { kind: 'idle' }
    : { kind: 'recheck', afterMs: quietRemainingMs + 50 }
}
