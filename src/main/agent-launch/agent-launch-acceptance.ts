/** A launch the host accepted while its workspace's required Setup may still be running.
 * The host, not its caller, owns the wait and the surface decision: it waits for the exact Setup run
 * the workspace's creation registered, then starts one chat or terminal, or nothing. */

import { awaitRequiredSetup, type SetupRun } from '../runtime/setup/setup-run'
import { AgentLaunchClosedBeforeDispatchError } from '../../shared/agent-launch-tab-closed'
import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'
import type { AgentLaunchTerminalStartupParams } from '../../shared/rpc-contract/agent-launch-accept-params'

export type AgentLaunchAcceptance = {
  /** Captured at acceptance; absent means the workspace has no Setup to wait for. */
  requiredSetup: SetupRun | undefined
  /** The caller's own command for a terminal alternative, run verbatim. */
  terminalStartup?: AgentLaunchTerminalStartupParams
  /** Aborts when the user closes the reserved chat before any surface exists. */
  closed: AbortSignal
}

/** Before either surface and after every wait: a closed chat starts nothing. */
export function assertAcceptedLaunchOpen(acceptance: AgentLaunchAcceptance | undefined): void {
  if (acceptance?.closed.aborted) {
    throw new AgentLaunchClosedBeforeDispatchError()
  }
}

export async function awaitAcceptedLaunchSetup(
  acceptance: AgentLaunchAcceptance,
  agent: string,
  signal: AbortSignal | undefined
): Promise<void> {
  assertAcceptedLaunchOpen(acceptance)
  try {
    await awaitRequiredSetup(
      acceptance.requiredSetup,
      agent,
      signal ? AbortSignal.any([signal, acceptance.closed]) : acceptance.closed
    )
  } catch (error) {
    assertAcceptedLaunchOpen(acceptance)
    throw error
  }
  assertAcceptedLaunchOpen(acceptance)
}

/** The terminal alternative delivers the launch prompt as the caller planned for its own terminal. */
export function acceptedTerminalIntent(
  intent: AgentLaunchIntent,
  acceptance: AgentLaunchAcceptance | undefined
): AgentLaunchIntent {
  const startup = acceptance?.terminalStartup
  return startup && intent.prompt
    ? { ...intent, prompt: { ...intent.prompt, delivery: startup.promptDelivery } }
    : intent
}
