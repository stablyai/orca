/**
 * Starting an agent in a workspace that already exists, through the host's `agent.launch`.
 *
 * The phone states intent (which agent, where, what to say) and the host decides whether it runs
 * as a structured chat or a terminal agent, and how the prompt reaches it. Kept free of React so
 * every outcome is unit-testable.
 */

import type {
  AgentLaunchPlacement,
  AgentLaunchPrompt,
  AgentLaunchResult
} from '../../../src/shared/agent-launch-intent'
import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { AGENT_LAUNCH_TAB_CLOSED_CODE } from '../../../src/shared/agent-launch-tab-closed'
import { makePaneKey } from '../../../src/shared/stable-pane-id'
import { createStructuredAgentSessionId } from '../../../src/shared/structured-agent-session-create'
import { STRUCTURED_AGENT_SESSION_CLIENT_OPTIONS_RUNTIME_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import { readMobileStructuredChatLaunchOptions } from './mobile-structured-chat-launch-options'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import { agentLaunchReplayRun } from '../tasks/mobile-workspace-create-operations'
import { agentLaunchExistingParams, readAgentLaunchSupport } from '../tasks/agent-launch-request'
import {
  classifyAgentLaunchReplayRefusal,
  isAgentLaunchReservationTakenRefusal
} from '../../../src/shared/agent-launch-replay-refusal'
import { sendReplayingAmbiguousDelivery } from '../tasks/replay-on-ambiguous-delivery'
import {
  structuredSessionOperationId,
  structuredSessionRandomUuid
} from './structured-session-operation-id'

// Why: the host waits up to 60s for a terminal agent to become ready before pasting the prompt,
// so a prompted launch must outlive that wait or the phone reports a launch that is still running.
export const PROMPTED_AGENT_LAUNCH_TIMEOUT_MS = 90_000

export const AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE =
  'Update Orca on your computer to start an agent from your phone.'

// host-status-gates keeps re-reading a failed status in the background, so the user need not act.
export const AGENT_LAUNCH_STATUS_UNREADABLE_MESSAGE = "Could not read this host's status. Retrying…"

export const AGENT_LAUNCH_UNCONFIRMED_MESSAGE =
  "Couldn't confirm the agent started. Check the workspace before trying again."

// The host started nothing, and the next tap reserves new ids.
export const AGENT_LAUNCH_RESERVATION_TAKEN_MESSAGE = "Couldn't start the agent. Try again."
// Who closed it, and whether the agent had started, are unknown here: the phone or the computer.
export const AGENT_LAUNCH_TAB_CLOSED_MESSAGE =
  "The agent's tab was closed, so the agent was stopped."

/**
 * The tab a launch will create, named by this device before it asks, so it can land there as soon
 * as the tab is listed rather than when the host replies (which waits for prompt delivery).
 *
 * Minted once per launch and sent unchanged on every replay: the host's replay fingerprint covers
 * both ids. A host that predates either field ignores it; the reply still names what it built.
 */
export type MobileAgentLaunchReservation = {
  /** The terminal pane: its tab and leaf halves, as the host lists them. */
  pane: { tabId: string; leafId: string }
  /** Only for an agent the host may start as a chat. */
  sessionId: string | null
}

export function reserveMobileAgentLaunch(
  agent: TuiAgent,
  randomUuid: () => string = structuredSessionRandomUuid
): MobileAgentLaunchReservation {
  return {
    pane: { tabId: randomUuid(), leafId: randomUuid() },
    sessionId: isAgentSessionHandleProvider(agent)
      ? createStructuredAgentSessionId(agent, randomUuid)
      : null
  }
}

export type MobileExistingAgentLaunch =
  /** The host answered. `promptDelivered` is null when no prompt was sent. */
  | { kind: 'launched'; result: AgentLaunchResult; promptDelivered: boolean | null }
  /** This host can't take the launch; nothing was started. */
  | { kind: 'unsupported' }
  /** The host refused before starting anything. */
  | { kind: 'failed'; message: string }
  /** The agent may or may not be running; the caller must not launch again on its own. */
  | { kind: 'unknown'; message: string }
  /** A user closed the launch's tab, which stopped it; not a failure of the launch. */
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
  prompt?: AgentLaunchPrompt
  launchSource?: string
  reservation?: MobileAgentLaunchReservation
  placement?: AgentLaunchPlacement
  // Injected in tests; each call is one new operation, so a later tap never replays this one.
  mintOperationId?: () => string
}): Promise<MobileExistingAgentLaunch> {
  if (!supportsMobileExistingAgentLaunch(args.hostCapabilities)) {
    return { kind: 'unsupported' }
  }
  const sessionOptions = args.hostCapabilities?.includes(
    STRUCTURED_AGENT_SESSION_CLIENT_OPTIONS_RUNTIME_CAPABILITY
  )
    ? await readMobileStructuredChatLaunchOptions(args.client, args.agent)
    : undefined
  const params = agentLaunchExistingParams({
    agent: args.agent,
    worktreeId: args.worktreeId,
    ...(sessionOptions !== undefined ? { sessionOptions } : {}),
    operationId: (args.mintOperationId ?? structuredSessionOperationId)(),
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.launchSource ? { launchSource: args.launchSource } : {}),
    ...(args.placement ? { placement: args.placement } : {}),
    ...(args.reservation
      ? {
          paneKey: makePaneKey(args.reservation.pane.tabId, args.reservation.pane.leafId),
          ...(args.reservation.sessionId ? { sessionId: args.reservation.sessionId } : {})
        }
      : {})
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
