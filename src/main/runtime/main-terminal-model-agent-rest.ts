import type { TuiAgent } from '../../shared/tui-agent'

/**
 * Whether main's model of a pane running `agent` may go dormant. Why only Freebuff stays live:
 * its status is read from main's screen on every chunk. Every other screen reader is a tui-idle
 * read, which wakes the model and holds a ready verdict until the rebuilt screen is there.
 */
export function canAgentMainTerminalModelRest(agent: TuiAgent): boolean {
  return agent !== 'freebuff'
}
