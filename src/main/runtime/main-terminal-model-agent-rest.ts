import type { TuiAgent } from '../../shared/tui-agent'
import { readsTrustedScreen, rulesReadScreen } from './agent-state-rules/agent-state-rules-engine'
import { hasScreenInputVeto } from './screen-input-veto'

/**
 * Whether main's model of a pane running `agent` may go dormant. Why per agent: only the
 * agents below read main's screen. Their waits read it synchronously, and a model that is still
 * being rebuilt reads as no screen, which their rules take as no refusal. Every other agent's
 * readiness comes from hooks, titles and the text tail, which main keeps without its model.
 */
export function canAgentMainTerminalModelRest(agent: TuiAgent): boolean {
  return !(
    // Freebuff's status is read from main's screen on every chunk.
    agent === 'freebuff' ||
    // Qoder's composer readiness is a screen read outside its rules.
    agent === 'qoder' ||
    agent === 'qoder-cn' ||
    hasScreenInputVeto(agent) ||
    readsTrustedScreen(agent) ||
    rulesReadScreen(agent)
  )
}
