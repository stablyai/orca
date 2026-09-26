import type { SourceControlLaunchActionId } from '../../../src/shared/source-control-ai-actions'
import { buildSourceControlRecoveryAgentCommandInput } from '../../../src/shared/source-control-recovery-agent-command'
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
  /** The agent started but `prompt`, the text as sent, did not reach it; the caller offers it. */
  | { kind: 'prompt-not-sent'; prompt: string; warning?: string }
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
  const { recipe } = resolved
  // The desktop wraps each action's prompt in the user's saved template the same way.
  const text = args.actionId
    ? buildSourceControlRecoveryAgentCommandInput({
        actionId: args.actionId,
        commandInputTemplate: recipe?.commandInputTemplate,
        basePrompt: args.prompt
      })
    : args.prompt
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
    // Why no saved agent arguments: whether they apply depends on the route and shell the host picks
    // after this request, so the phone leaves them out and the agent's default arguments apply.
    prompt: { text, delivery: 'submit' },
    launchSource: args.launchSource
  })
  switch (launched.kind) {
    case 'launched': {
      const warning = launched.result.warning?.trim()
      const extra = warning ? { warning } : {}
      return launched.promptDelivered
        ? { kind: 'sent', ...extra }
        : { kind: 'prompt-not-sent', prompt: text, ...extra }
    }
    case 'unsupported':
      return { kind: 'not-started', message: AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE }
    case 'failed':
      return { kind: 'not-started', message: launched.message }
    case 'unknown':
      return { kind: 'unconfirmed', message: launched.message }
  }
}

/** What the button shows after a launch; one mapping so every AI button reads the same.
 *  `warning` is the host's note on a launch that went ahead, so it is never shown as a failure. */
export function promptedLaunchNotice(result: MobilePromptedAgentLaunch): {
  succeeded: boolean
  error: string | null
  warning: string | null
  undeliveredPrompt: string | null
} {
  switch (result.kind) {
    case 'sent':
      return {
        succeeded: true,
        error: null,
        warning: result.warning ?? null,
        undeliveredPrompt: null
      }
    case 'prompt-not-sent':
      return {
        succeeded: false,
        error: AGENT_PROMPT_NOT_SENT_MESSAGE,
        warning: result.warning ?? null,
        undeliveredPrompt: result.prompt
      }
    case 'not-started':
    case 'unconfirmed':
      return { succeeded: false, error: result.message, warning: null, undeliveredPrompt: null }
  }
}
