import type { AgentLaunchResult } from '../../shared/agent-launch/contracts/agent-launch-intent'
import {
  SETUP_AGENT_GATE,
  type RuntimeTerminalCreate
} from '../../shared/terminal/runtime/runtime-terminal-create-contract'

/** A published surface and, separately, its prompt settlement, which never rejects. */
export type AgentLaunchOpening = {
  surface: AgentLaunchResult
  /** The terminal the surface opened, as its factory created it. */
  terminalCreation?: RuntimeTerminalCreate
  settlement: Promise<PromiseSettledResult<AgentLaunchResult>>
}

export type DeferredSetupPrompt = true | ((settlement: AgentLaunchOpening['settlement']) => void)

export async function launchResult(
  opened: AgentLaunchOpening,
  deferredSetupPrompt: DeferredSetupPrompt | undefined
): Promise<AgentLaunchResult> {
  if (
    deferredSetupPrompt &&
    opened.terminalCreation?.[SETUP_AGENT_GATE] &&
    opened.surface.prompt?.outcome === 'unconfirmed'
  ) {
    if (typeof deferredSetupPrompt === 'function') {
      deferredSetupPrompt(opened.settlement)
    }
    return opened.surface
  }
  const settled = await opened.settlement
  if (settled.status === 'rejected') {
    throw settled.reason
  }
  return settled.value
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
