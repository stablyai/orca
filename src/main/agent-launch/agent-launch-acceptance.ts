/** A launch the host accepted while its workspace's required Setup may still be running.
 * The host, not its caller, owns the wait and the surface decision: it waits for the exact Setup run
 * the workspace's creation named, then starts one chat or terminal, or nothing. */

import {
  awaitSetupRunSuccess,
  AgentLaunchSetupNotCompletedError,
  type SetupRun
} from '../runtime/setup/setup-run'
import { AgentLaunchClosedBeforeDispatchError } from '../../shared/agent-launch-tab-closed'
import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'
import { formatAgentTypeLabel } from '../../shared/agent-type-label'
import type {
  AgentLaunchSetupReceipt,
  AgentLaunchTerminalStartupParams
} from '../../shared/rpc-contract/agent-launch-accept-params'
import { AgentLaunchSurfaceUnavailableError } from './agent-launch-surface-refusal'

export type AgentLaunchAcceptance = {
  /** What the workspace's creation reported about the Setup this launch waits for. */
  setupReceipt: AgentLaunchSetupReceipt
  /** This host's run for the workspace, read once and only after admission: a recorded answer comes first. */
  readSetupRun: () => Promise<SetupRun | undefined>
  /** The caller's own terminal alternative; absent, a refused chat starts nothing. */
  terminalStartup?: AgentLaunchTerminalStartupParams
  /** The held message's id, which its chat founds it under. */
  clientMessageId?: string
  /** Aborts when the user closes the reserved chat; every owner checks it before it commits. */
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
  const receipt = acceptance.setupReceipt
  if (!receipt.required) {
    return
  }
  const run =
    receipt.runId === null ? undefined : await acceptance.readSetupRun().catch(() => undefined)
  assertAcceptedLaunchOpen(acceptance)
  if (!run || run.id !== receipt.runId) {
    // A restarted host, an evicted or replaced run: the required run's success can no longer be shown.
    throw new AgentLaunchSetupNotCompletedError(
      { kind: 'ended', reason: 'observation_lost' },
      agent
    )
  }
  try {
    await awaitSetupRunSuccess(
      run,
      agent,
      signal ? AbortSignal.any([signal, acceptance.closed]) : acceptance.closed
    )
  } catch (error) {
    assertAcceptedLaunchOpen(acceptance)
    throw error
  }
  assertAcceptedLaunchOpen(acceptance)
}

/** The launch prompt as the caller's plan has its terminal take it: sent after start, or left unsent
 *  in the agent's input. Text the command carries, or that the plan leaves out, keeps its own word. */
export function acceptedTerminalIntent(
  intent: AgentLaunchIntent,
  acceptance: AgentLaunchAcceptance | undefined
): AgentLaunchIntent {
  const plan = acceptance?.terminalStartup?.prompt
  if ((plan !== 'submit' && plan !== 'draft') || !intent.prompt) {
    return intent
  }
  return { ...intent, prompt: { ...intent.prompt, delivery: plan } }
}

/** An accepted launch whose caller planned no terminal: a refused chat ends it before any effect. */
export function assertAcceptedTerminalAlternative(
  acceptance: AgentLaunchAcceptance | undefined,
  agent: string
): void {
  if (acceptance && !acceptance.terminalStartup) {
    const name = formatAgentTypeLabel(agent)
    throw new AgentLaunchSurfaceUnavailableError(
      `${name} can't open as a chat here, so it was not started. Start it in a terminal instead.`
    )
  }
}
