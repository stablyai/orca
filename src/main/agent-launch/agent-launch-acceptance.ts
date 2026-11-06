/** A launch the host accepted while its workspace's required Setup may still be running.
 * The host, not its caller, owns the wait and the surface decision: it waits for the exact Setup run
 * the workspace's creation named, then starts one chat or terminal, or nothing. */

import {
  awaitSetupRunSuccess,
  AgentLaunchSetupNotCompletedError,
  type SetupRun
} from '../runtime/setup/setup-run'
import { AgentLaunchClosedBeforeDispatchError } from '../../shared/agent-launch/contracts/agent-launch-tab-closed'
import type { AgentLaunchIntent } from '../../shared/agent-launch/contracts/agent-launch-intent'
import { formatAgentTypeLabel } from '../../shared/agent-status/presentation/agent-type-label'
import type {
  AgentLaunchSetupReceipt,
  AgentLaunchTerminalStartupParams
} from '../../shared/rpc-contract/agent-launch-accept-params'
import { AgentLaunchSurfaceUnavailableError } from './agent-launch-surface-refusal'
import type { AgentLaunchReleaseGate } from './agent-launch-release-gate'
import type { AgentLaunchSurfaceExecution } from './agent-launch-execution'
import { launchPromptCreateInputs } from './agent-launch-prompt-delivery'
import type { StructuredAgentSessionFirstMessage } from '../../shared/agent-session/structured-agent-session-create'

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
  /** A prepared launch: after Setup it waits here for its final input, whose choices replace the
   *  absent ones above and compile its terminal alternative. */
  release?: AgentLaunchReleaseGate
}

/** The caller's terminal alternative: as sent, or a prepared launch's recipe compiled with its input. */
export function acceptedTerminalStartup(
  acceptance: AgentLaunchAcceptance | undefined
): AgentLaunchTerminalStartupParams | undefined {
  return acceptance?.release ? acceptance.release.terminalStartup() : acceptance?.terminalStartup
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
    acceptance.release?.setupSucceeded()
    return
  }
  const run =
    receipt.runId === null ? undefined : await acceptance.readSetupRun().catch(() => undefined)
  assertAcceptedLaunchOpen(acceptance)
  acceptance.release?.assertWaiting()
  if (!run || run.id !== receipt.runId) {
    // A restarted host, an evicted or replaced run: the required run's success can no longer be shown.
    throw new AgentLaunchSetupNotCompletedError(
      { kind: 'ended', reason: 'observation_lost' },
      agent
    )
  }
  // A prepared launch's wait can end first, at its horizon, while Setup still runs.
  const ends = [signal, acceptance.closed, acceptance.release?.endedSignal].filter(
    (end): end is AbortSignal => end !== undefined
  )
  try {
    await awaitSetupRunSuccess(run, agent, ends.length === 1 ? ends[0] : AbortSignal.any(ends))
  } catch (error) {
    assertAcceptedLaunchOpen(acceptance)
    acceptance.release?.assertWaiting()
    throw error
  }
  assertAcceptedLaunchOpen(acceptance)
  acceptance.release?.assertWaiting()
  acceptance.release?.setupSucceeded()
}

/** Where the caller's plan puts the held message. The plan's own draft owns the agent's input, so a
 *  held message it would paste or type there stays unsent, as the creation's own terminal leaves it. */
export function acceptedHeldMessagePlan(
  startup: AgentLaunchTerminalStartupParams | undefined
): AgentLaunchTerminalStartupParams['prompt'] | undefined {
  const plan = startup?.prompt
  return startup?.kind === 'command' &&
    startup.draftPrompt &&
    (plan === 'submit' || plan === 'draft')
    ? 'none'
    : plan
}

/** The launch prompt as the caller's plan has its terminal take it: sent after start, or left unsent
 *  in the agent's input. Text the command carries, or that the plan leaves out, keeps its own word. */
export function acceptedTerminalIntent(
  intent: AgentLaunchIntent,
  acceptance: AgentLaunchAcceptance | undefined
): AgentLaunchIntent {
  const plan = acceptedHeldMessagePlan(acceptedTerminalStartup(acceptance))
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
  if (acceptance && !acceptedTerminalStartup(acceptance)) {
    const name = formatAgentTypeLabel(agent)
    throw new AgentLaunchSurfaceUnavailableError(
      `${name} can't open as a chat here, so it was not started. Start it in a terminal instead.`
    )
  }
}

/** The execution once its input is installed, delivering the released message rather than any text
 *  prepare carried: prepare names the message, release brings it. */
export async function releasedExecution(
  execution: AgentLaunchSurfaceExecution,
  gate: AgentLaunchReleaseGate
): Promise<AgentLaunchSurfaceExecution> {
  await gate.finalInput()
  const { prompt: _prepared, ...intent } = execution.intent
  const prompt = gate.releasedPrompt()
  return { ...execution, intent: prompt ? { ...intent, prompt } : intent }
}

/** The chat's opening message: a prepared launch's released one whole (images, files, skills) under
 *  the ordinary admission, or the text an accepted or ordinary launch carries. */
export function acceptedFirstMessageInputs(execution: AgentLaunchSurfaceExecution): {
  firstMessage?: StructuredAgentSessionFirstMessage
  signal?: AbortSignal
} {
  const { acceptance, signal } = execution
  if (!acceptance?.release) {
    return launchPromptCreateInputs(execution.intent, signal, acceptance?.clientMessageId)
  }
  const firstMessage = acceptance.release.releasedFirstMessage()
  return firstMessage ? { firstMessage, ...(signal ? { signal } : {}) } : {}
}
