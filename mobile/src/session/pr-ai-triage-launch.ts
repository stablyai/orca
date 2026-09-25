import type { SourceControlLaunchActionId } from '../../../src/shared/source-control-ai-actions'
import type { RpcClient } from '../transport/rpc-client'
import {
  AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE,
  launchAgentInExistingWorkspace,
  supportsMobileExistingAgentLaunch
} from './mobile-existing-agent-launch'
import { loadMobileAgentLaunchContext } from './mobile-new-tab-agent-loader'
import { resolveMobileSourceControlLaunchAgent } from './mobile-source-control-launch-agent'

// Launch path for the phone's AI buttons ("Fix checks with AI", "Resolve conflicts with AI", commit
// recovery, review notes). The host starts the agent and delivers the prompt; the phone never
// types a prompt into a shell. Kept free of react-native imports so it unit-tests under node.

export type MobilePromptedAgentLaunch =
  | { kind: 'sent'; warning?: string }
  /** The agent started but the prompt did not reach it; the caller keeps the text. */
  | { kind: 'prompt-not-sent'; warning?: string }
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
      await loadMobileAgentLaunchContext({ client: args.client, worktreeId: args.worktreeId }),
      args.actionId
    )
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : ''
    return { kind: 'not-started', message: message || 'Could not load the available agents.' }
  }
  if (resolved.kind === 'unavailable') {
    return { kind: 'not-started', message: resolved.message }
  }
  const launched = await launchAgentInExistingWorkspace({
    client: args.client,
    hostCapabilities: args.hostCapabilities,
    worktreeId: args.worktreeId,
    agent: resolved.agent,
    ...(resolved.agentArgs !== undefined ? { agentArgs: resolved.agentArgs } : {}),
    prompt: { text: args.prompt, delivery: 'submit' },
    launchSource: args.launchSource
  })
  switch (launched.kind) {
    case 'launched': {
      const warning = launched.result.warning?.trim()
      const extra = warning ? { warning } : {}
      return launched.promptDelivered
        ? { kind: 'sent', ...extra }
        : { kind: 'prompt-not-sent', ...extra }
    }
    case 'unsupported':
      return { kind: 'not-started', message: AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE }
    case 'failed':
      return { kind: 'not-started', message: launched.message }
    case 'unknown':
      return { kind: 'unconfirmed', message: launched.message }
  }
}

/** What the button shows after a launch; one mapping so every AI button reads the same. */
export function promptedLaunchNotice(
  result: MobilePromptedAgentLaunch,
  prompt: string
): { succeeded: boolean; error: string | null; undeliveredPrompt: string | null } {
  switch (result.kind) {
    case 'sent':
      return { succeeded: true, error: result.warning ?? null, undeliveredPrompt: null }
    case 'prompt-not-sent':
      return {
        succeeded: false,
        error: result.warning
          ? `${AGENT_PROMPT_NOT_SENT_MESSAGE} ${result.warning}`
          : AGENT_PROMPT_NOT_SENT_MESSAGE,
        undeliveredPrompt: prompt
      }
    case 'not-started':
    case 'unconfirmed':
      return { succeeded: false, error: result.message, undeliveredPrompt: null }
  }
}
