import type { AgentLaunchResult } from '../../../src/shared/agent-launch-intent'
import type { SourceControlLaunchActionId } from '../../../src/shared/source-control-ai-actions'
import type { RpcClient } from '../transport/rpc-client'
import {
  AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE,
  launchAgentInExistingWorkspace,
  supportsMobileExistingAgentLaunch
} from './mobile-existing-agent-launch'
import {
  hostRefusesOtherRuntimeWorkspace,
  loadMobileAgentLaunchContext
} from './mobile-new-tab-agent-loader'
import { resolveMobileSourceControlLaunchAgent } from './mobile-source-control-launch-agent'
import { projectSourceControlActionLaunch } from '../../../src/shared/source-control-action-launch-preferences'

// Have the host launch and deliver AI prompts; mobile must never type them into a shell.

export type MobilePromptedAgentLaunch =
  | { kind: 'sent'; launch: AgentLaunchResult }
  /** The agent started but `prompt`, the text as sent, did not reach it; the caller offers it. */
  | { kind: 'prompt-not-sent'; prompt: string; launch: AgentLaunchResult }
  /** Nothing started; `message` says why. */
  | { kind: 'not-started'; message: string }
  /** The agent may be running; do not launch again until the user has looked. */
  | { kind: 'unconfirmed'; message: string }

export const AGENT_PROMPT_NOT_SENT_MESSAGE = "The agent started, but the prompt wasn't sent."

export async function launchAgentWithPrompt(args: {
  client: RpcClient
  hostCapabilities: readonly string[] | null | undefined
  worktreeId: string
  actionId: SourceControlLaunchActionId | null
  prompt: string
  launchSource: string
}): Promise<MobilePromptedAgentLaunch> {
  if (!supportsMobileExistingAgentLaunch(args.hostCapabilities)) {
    return { kind: 'not-started', message: AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE }
  }
  let resolved
  try {
    resolved = resolveMobileSourceControlLaunchAgent(
      await loadMobileAgentLaunchContext({
        client: args.client,
        worktreeId: args.worktreeId,
        hostRefusesOtherRuntime: hostRefusesOtherRuntimeWorkspace(args.hostCapabilities)
      }),
      args.actionId
    )
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : ''
    return { kind: 'not-started', message: message || 'Could not load the available agents.' }
  }
  if (resolved.kind === 'unavailable') {
    return { kind: 'not-started', message: resolved.message }
  }
  const { recipe } = resolved
  const projection = projectSourceControlActionLaunch(recipe ?? {}, resolved.agent, {
    basePrompt: args.prompt
  })
  const text = projection.commandInput
  if (!text) {
    return {
      kind: 'not-started',
      message:
        "This action's saved prompt is empty. Update Source Control AI settings on your computer."
    }
  }
  const launched = await launchAgentInExistingWorkspace({
    client: args.client,
    hostCapabilities: args.hostCapabilities,
    worktreeId: args.worktreeId,
    agent: resolved.agent,
    ...(projection.sessionOptions ? { chatOptions: projection.sessionOptions } : {}),
    // The phone lacks the workspace shell needed to project inherited choices over raw flags.
    agentArgs: projection.sessionOptionsYieldToAgentArgs ? undefined : projection.agentArgs,
    surface: projection.requestedSurface,
    prompt: { text, delivery: 'submit' },
    launchSource: args.launchSource
  })
  switch (launched.kind) {
    case 'launched': {
      return launched.promptDelivered
        ? { kind: 'sent', launch: launched.result }
        : { kind: 'prompt-not-sent', prompt: text, launch: launched.result }
    }
    case 'unsupported':
      return { kind: 'not-started', message: AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE }
    case 'failed':
    case 'tab-closed':
      return { kind: 'not-started', message: launched.message }
    case 'unknown':
      return { kind: 'unconfirmed', message: launched.message }
  }
}

export type PromptedLaunchNotice = {
  launch: AgentLaunchResult | null
  error: string | null
  undeliveredPrompt: string | null
}

export function promptedLaunchNotice(result: MobilePromptedAgentLaunch): PromptedLaunchNotice {
  switch (result.kind) {
    case 'sent':
      return {
        launch: result.launch,
        error: null,
        undeliveredPrompt: null
      }
    case 'prompt-not-sent':
      return {
        launch: result.launch,
        error: AGENT_PROMPT_NOT_SENT_MESSAGE,
        undeliveredPrompt: result.prompt
      }
    case 'not-started':
    case 'unconfirmed':
      return {
        launch: null,
        error: result.message,
        undeliveredPrompt: null
      }
  }
}
