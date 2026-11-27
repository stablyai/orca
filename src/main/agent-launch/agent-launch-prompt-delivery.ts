import {
  SETUP_AGENT_GATE,
  type RuntimeTerminalCreate
} from '../../shared/terminal/runtime/runtime-terminal-create-contract'
import { randomUUID } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { structuredAgentSessionSendBody } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { StructuredAgentSessionFirstMessage } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type {
  AgentLaunchIntent,
  AgentLaunchPromptDisposal,
  AgentLaunchResult,
  AgentLaunchModeReceipt
} from '../../shared/agent-launch/contracts/agent-launch-intent'
import { agentPromptRidesLaunchCommand } from '../../shared/agent-launch/startup/tui-agent-startup'

import type { CreatedSurface } from './agent-launch-executor'
import type { AgentLaunchSurfaceExecution } from './agent-launch-execution'

function structuredLaunchSubmitText(intent: Pick<AgentLaunchIntent, 'prompt'>): string | undefined {
  return intent.prompt?.delivery === 'submit' && intent.prompt.text.trim().length > 0
    ? intent.prompt.text
    : undefined
}

export function launchPromptCreateInputs(
  intent: Pick<AgentLaunchIntent, 'prompt'>,
  signal?: AbortSignal
): { firstMessage?: StructuredAgentSessionFirstMessage; signal?: AbortSignal } {
  const text = structuredLaunchSubmitText(intent)
  return text !== undefined
    ? {
        firstMessage: {
          clientMessageId: createStructuredAgentSessionOperationId(randomUUID),
          body: structuredAgentSessionSendBody(text, [])
        },
        ...(signal ? { signal } : {})
      }
    : {}
}

export const HANDED_TO_TERMINAL: AgentLaunchPromptDisposal = { outcome: 'handed-to-terminal' }
const NOT_DELIVERED: AgentLaunchPromptDisposal = { outcome: 'not-delivered' }
const UNCONFIRMED: AgentLaunchPromptDisposal = { outcome: 'unconfirmed' }

/** Persist owed submits as unconfirmed: a crash during delivery must not invite duplicate turns. */
export function settledAtCreation(
  intent: Pick<AgentLaunchIntent, 'prompt'>,
  created: Pick<CreatedSurface, 'promptRodeLaunchCommand' | 'structured' | 'terminalCreation'>
): AgentLaunchPromptDisposal {
  if (created.structured?.firstMessage) {
    return { outcome: 'journaled', messageId: created.structured.firstMessage.clientMessageId }
  }
  if (created.structured) {
    return structuredLaunchSubmitText(intent) === undefined ? NOT_DELIVERED : UNCONFIRMED
  }
  const gate = created.terminalCreation?.[SETUP_AGENT_GATE]
  if (created.terminalCreation?.agentProgramBlocked || gate?.blocked) {
    return NOT_DELIVERED
  }
  if (created.promptRodeLaunchCommand) {
    return gate ? UNCONFIRMED : HANDED_TO_TERMINAL
  }
  return intent.prompt?.delivery === 'submit' ? UNCONFIRMED : NOT_DELIVERED
}

export async function settleLaunchPromptDisposal(
  execution: AgentLaunchSurfaceExecution,
  created: CreatedSurface
): Promise<AgentLaunchPromptDisposal> {
  const gate = created.terminalCreation?.[SETUP_AGENT_GATE]
  if (created.terminalCreation?.agentProgramBlocked || gate?.blocked) {
    return NOT_DELIVERED
  }
  if (gate && created.promptRodeLaunchCommand) {
    const outcome = await waitForPromiseWithSignal(gate.outcome, execution.signal).catch(
      () => undefined
    )
    // The setup marker precedes the agent wrapper, so it cannot confirm argv handoff.
    return outcome === 'blocked' || outcome === 'failed' ? NOT_DELIVERED : UNCONFIRMED
  }
  if (created.structured || created.promptRodeLaunchCommand) {
    return settledAtCreation(execution.intent, created)
  }
  return deliverTerminalLaunchPrompt(execution, created.outcome.handle, {
    freshLaunch: true,
    terminalCreation: created.terminalCreation
  })
}

/** PTY writes prove handoff, not consumption; drafts remain undelivered because acceptance is unobservable. */
export async function deliverTerminalLaunchPrompt(
  execution: AgentLaunchSurfaceExecution,
  handle: string,
  {
    freshLaunch,
    terminalCreation
  }: { freshLaunch: boolean; terminalCreation?: RuntimeTerminalCreate }
): Promise<AgentLaunchPromptDisposal> {
  const { intent, surfaces, signal } = execution
  if (!intent.prompt || intent.prompt.delivery !== 'submit' || signal?.aborted) {
    return NOT_DELIVERED
  }
  const delivered = await surfaces.deliverTerminalPrompt?.({
    handle,
    agent: intent.agent,
    freshLaunch,
    terminalCreation,
    prompt: intent.prompt,
    ...(signal ? { signal } : {})
  })
  return delivered ? HANDED_TO_TERMINAL : NOT_DELIVERED
}

function launchSubmitText(intent: AgentLaunchIntent): string | undefined {
  return intent.prompt?.delivery === 'submit' && intent.prompt.text ? intent.prompt.text : undefined
}

/** Offer argv prompts; only the surface building the typed line can confirm that they fit. */
export function argvLaunchPrompt(intent: AgentLaunchIntent): string | undefined {
  const text = launchSubmitText(intent)
  return text && agentPromptRidesLaunchCommand(intent.agent) ? text : undefined
}

export function launchCommandPrompt(
  intent: AgentLaunchIntent,
  mode: AgentLaunchModeReceipt['mode']
): string | undefined {
  return mode === 'terminal' ? argvLaunchPrompt(intent) : undefined
}

export function promptReceipt(
  intent: AgentLaunchIntent,
  disposal: AgentLaunchPromptDisposal
): Pick<AgentLaunchResult, 'prompt'> {
  if (!intent.prompt) {
    return {}
  }
  return { prompt: { delivery: intent.prompt.delivery, ...disposal } }
}
