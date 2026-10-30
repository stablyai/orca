// Send launch intent to the host, which selects terminal versus structured execution and prompt delivery.

import {
  AGENT_LAUNCH_CHAT_OPTIONS_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY
} from '../../../src/shared/agent-launch-runtime-capability'
import type {
  AgentLaunchPlacement,
  AgentLaunchPrompt,
  AgentLaunchResult
} from '../../../src/shared/agent-launch-intent'
import { isStructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import { AGENT_LAUNCH_TAB_CLOSED_CODE } from '../../../src/shared/agent-launch-tab-closed'
import { makePaneKey } from '../../../src/shared/stable-pane-id'
import { createStructuredAgentSessionId } from '../../../src/shared/structured-agent-session-create'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import { agentLaunchReplayRun } from '../tasks/mobile-workspace-create-operations'
import { agentLaunchExistingParams, readAgentLaunchSupport } from '../tasks/agent-launch-request'
import {
  classifyAgentLaunchReplayRefusal,
  isAgentLaunchReservationTakenRefusal
} from '../../../src/shared/agent-launch-replay-refusal'
import { sendReplayingAmbiguousDelivery } from '../tasks/replay-on-ambiguous-delivery'
import { structuredSessionOperationId } from './structured-session-operation-id'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { rememberMobileCreatedStructuredSession } from './mobile-created-structured-sessions'

// Why: the host waits up to 60s for a terminal agent to become ready before pasting the prompt,
// so a prompted launch must outlive that wait or the phone reports a launch that is still running.
export const PROMPTED_AGENT_LAUNCH_TIMEOUT_MS = 90_000

export const AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE =
  'Update Orca on your computer to start an agent from your phone.'

// host-status-gates keeps re-reading a failed status in the background, so the user need not act.
export const AGENT_LAUNCH_STATUS_UNREADABLE_MESSAGE = "Could not read this host's status. Retrying…"

export const AGENT_LAUNCH_UNCONFIRMED_MESSAGE =
  "Couldn't confirm the agent started. Check the workspace before trying again."

export const AGENT_LAUNCH_RESERVATION_TAKEN_MESSAGE = "Couldn't start the agent. Try again."
export const AGENT_LAUNCH_TAB_CLOSED_MESSAGE =
  "The agent's tab was closed, so the agent was stopped."

// Reserve ids once so snapshots can select the new tab before prompt delivery replies; replays must reuse both ids covered by the host fingerprint.
export type MobileAgentLaunchReservation = {
  pane: { tabId: string; leafId: string }
  sessionId: string | null
}

export function reserveMobileAgentLaunch(
  agent: TuiAgent,
  randomUuid: () => string = randomV4Uuid
): MobileAgentLaunchReservation {
  return {
    pane: { tabId: randomUuid(), leafId: randomUuid() },
    sessionId: isStructuredAgentId(agent) ? createStructuredAgentSessionId(agent, randomUuid) : null
  }
}

export type MobileExistingAgentLaunch =
  | { kind: 'launched'; result: AgentLaunchResult; promptDelivered: boolean | null }
  | { kind: 'unsupported' }
  | { kind: 'failed'; message: string }
  // Unknown delivery must not trigger an automatic new launch.
  | { kind: 'unknown'; message: string }
  | { kind: 'tab-closed'; message: string }

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
  surface?: 'chat' | 'terminal'
  prompt?: AgentLaunchPrompt
  /** Model and effort the host applies on whichever route it picks. */
  sessionOptions?: Readonly<Record<string, string>>
  chatOptions?: Readonly<Record<string, string>>
  launchSource?: string
  reservation?: MobileAgentLaunchReservation
  placement?: AgentLaunchPlacement
  mintOperationId?: () => string
}): Promise<MobileExistingAgentLaunch> {
  if (!supportsMobileExistingAgentLaunch(args.hostCapabilities)) {
    return { kind: 'unsupported' }
  }
  const params = agentLaunchExistingParams({
    agent: args.agent,
    agentArgs: args.agentArgs,
    ...(args.surface && args.hostCapabilities?.includes(AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY)
      ? { surface: args.surface }
      : {}),
    worktreeId: args.worktreeId,
    operationId: (args.mintOperationId ?? structuredSessionOperationId)(),
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.sessionOptions ? { sessionOptions: args.sessionOptions } : {}),
    ...(args.chatOptions &&
    args.hostCapabilities?.includes(AGENT_LAUNCH_CHAT_OPTIONS_RUNTIME_CAPABILITY)
      ? { chatOptions: args.chatOptions }
      : {}),
    ...(args.launchSource ? { launchSource: args.launchSource } : {}),
    ...(args.placement ? { placement: args.placement } : {}),
    ...(args.reservation
      ? {
          paneKey: makePaneKey(args.reservation.pane.tabId, args.reservation.pane.leafId),
          ...(args.reservation.sessionId ? { sessionId: args.reservation.sessionId } : {})
        }
      : {})
  })
  if (args.reservation?.sessionId) {
    rememberMobileCreatedStructuredSession(args.reservation.sessionId, `id:${args.worktreeId}`)
  }
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
    // Missing prompted-launch receipts underclaim success so the phone retains its draft.
    promptDelivered: args.prompt
      ? result.prompt !== undefined && result.prompt.outcome !== 'not-delivered'
      : null
  }
}

function classifyLaunchRefusal(
  error: { code?: string; message?: string },
  replayed: boolean
): MobileExistingAgentLaunch {
  switch (classifyAgentLaunchReplayRefusal(error, replayed)) {
    case 'unsupported':
      return { kind: 'unsupported' }
    case 'unknown':
      return { kind: 'unknown', message: AGENT_LAUNCH_UNCONFIRMED_MESSAGE }
    case 'failed': {
      if (isAgentLaunchReservationTakenRefusal(error)) {
        return { kind: 'failed', message: AGENT_LAUNCH_RESERVATION_TAKEN_MESSAGE }
      }
      if (error.code === AGENT_LAUNCH_TAB_CLOSED_CODE) {
        return { kind: 'tab-closed', message: AGENT_LAUNCH_TAB_CLOSED_MESSAGE }
      }
      const message = error.message?.trim()
      return { kind: 'failed', message: message || "Couldn't start the agent." }
    }
  }
}
