import type { AgentLaunchResult } from '../../shared/agent-launch/contracts/agent-launch-intent'
import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-create-contract'

/** A published surface and, separately, its prompt settlement, which never rejects. */
export type AgentLaunchOpening = {
  surface: AgentLaunchResult
  /** The terminal the surface opened, as its factory created it. */
  terminalCreation?: RuntimeTerminalCreate
  settlement: Promise<PromiseSettledResult<AgentLaunchResult>>
}

/** Start delivery now; its outcome is captured so a late rejection is never unhandled. */
export function opening(
  surface: AgentLaunchResult,
  settle: () => Promise<AgentLaunchResult>,
  terminalCreation?: RuntimeTerminalCreate
): AgentLaunchOpening {
  return {
    surface,
    ...(terminalCreation ? { terminalCreation } : {}),
    settlement: settle().then(
      (value) => ({ status: 'fulfilled', value }),
      (reason: unknown) => ({ status: 'rejected', reason })
    )
  }
}
