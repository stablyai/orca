/**
 * Starting an agent in a workspace that already exists, through the host's `agent.launch`.
 *
 * The phone states intent (which agent, where, what to say) and the host decides whether it runs
 * as a structured chat or a terminal agent, and how the prompt reaches it. Kept free of React so
 * every outcome is unit-testable.
 */

import type { AgentLaunchPrompt, AgentLaunchResult } from '../../../src/shared/agent-launch-intent'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import { agentLaunchReplayRun } from '../tasks/mobile-workspace-create-operations'
import {
  agentLaunchExistingParams,
  isAgentLaunchReplayUnsupportedRefusal,
  readAgentLaunchSupport
} from '../tasks/agent-launch-request'
import { sendReplayingAmbiguousDelivery } from '../tasks/replay-on-ambiguous-delivery'
import { structuredSessionOperationId } from './structured-session-operation-id'

// Why: the host waits up to 60s for a terminal agent to become ready before pasting the prompt,
// so a prompted launch must outlive that wait or the phone reports a launch that is still running.
export const PROMPTED_AGENT_LAUNCH_TIMEOUT_MS = 90_000

export const AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE =
  'Update Orca on your computer to start an agent from your phone.'

export const AGENT_LAUNCH_UNCONFIRMED_MESSAGE =
  "Couldn't confirm the agent started. Check the workspace before trying again."

export type MobileExistingAgentLaunch =
  /** The host answered. `promptDelivered` is null when no prompt was sent. */
  | { kind: 'launched'; result: AgentLaunchResult; promptDelivered: boolean | null }
  /** This host can't take the launch; nothing was started. */
  | { kind: 'unsupported' }
  /** The host refused before starting anything. */
  | { kind: 'failed'; message: string }
  /** The agent may or may not be running; the caller must not launch again on its own. */
  | { kind: 'unknown'; message: string }

export function supportsMobileExistingAgentLaunch(
  hostCapabilities: readonly string[] | null | undefined
): boolean {
  const support = readAgentLaunchSupport(hostCapabilities)
  return support !== false && support.replay
}

export async function launchAgentInExistingWorkspace(args: {
  client: RpcClient
  hostCapabilities: readonly string[] | null | undefined
  worktreeId: string
  agent: TuiAgent
  agentArgs?: string
  prompt?: AgentLaunchPrompt
  launchSource?: string
  // Injected in tests; each call is one new operation, so a later tap never replays this one.
  mintOperationId?: () => string
}): Promise<MobileExistingAgentLaunch> {
  if (!supportsMobileExistingAgentLaunch(args.hostCapabilities)) {
    return { kind: 'unsupported' }
  }
  const params = agentLaunchExistingParams({
    agent: args.agent,
    worktreeId: args.worktreeId,
    operationId: (args.mintOperationId ?? structuredSessionOperationId)(),
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.launchSource ? { launchSource: args.launchSource } : {})
  })
  let sent
  try {
    sent = await sendReplayingAmbiguousDelivery(
      args.client,
      () =>
        agentLaunchReplayRun.request(
          args.client,
          params,
          args.prompt ? { timeoutMs: PROMPTED_AGENT_LAUNCH_TIMEOUT_MS } : undefined
        ),
      { kind: 'durable' }
    )
  } catch {
    // The request reached the wire and no answer came back, even after replays.
    return { kind: 'unknown', message: AGENT_LAUNCH_UNCONFIRMED_MESSAGE }
  }
  const { response, replayed } = sent
  if (!response.ok) {
    return classifyLaunchRefusal(response.error, replayed)
  }
  let result: AgentLaunchResult
  try {
    result = agentLaunchReplayRun.interpret(response)
  } catch {
    return { kind: 'unknown', message: AGENT_LAUNCH_UNCONFIRMED_MESSAGE }
  }
  return {
    kind: 'launched',
    result,
    // A receipt missing from a prompted launch under-claims: the phone keeps the text.
    promptDelivered: args.prompt
      ? result.prompt !== undefined && result.prompt.outcome !== 'not-delivered'
      : null
  }
}

function classifyLaunchRefusal(
  error: { code?: string; message?: string },
  replayed: boolean
): MobileExistingAgentLaunch {
  if (isAgentLaunchReplayUnsupportedRefusal(error)) {
    // Only a refusal of the first send proves nothing ran; after a replay it may be a replacement
    // connection whose capability list hasn't landed, answering for an attempt that did start.
    return replayed
      ? { kind: 'unknown', message: AGENT_LAUNCH_UNCONFIRMED_MESSAGE }
      : { kind: 'unsupported' }
  }
  if (
    error.code === 'agent_session_operation_unknown' ||
    error.code === 'agent_session_operation_expired'
  ) {
    return { kind: 'unknown', message: AGENT_LAUNCH_UNCONFIRMED_MESSAGE }
  }
  const message = error.message?.trim()
  return { kind: 'failed', message: message || "Couldn't start the agent." }
}
