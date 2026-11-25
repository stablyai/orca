import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultSessionHandoffPrompts } from '../../../src/shared/ai-vault/contracts/ai-vault-session-handoff'
import { AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS } from '../../../src/shared/ai-vault/contracts/ai-vault-session-handoff'
import type { AgentSessionContinuationContextMode } from '../../../src/shared/agent-session/conversation-context/agent-session-continuation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { interpretOrThrowRefusalMessage } from '../transport/rpc/rpc-refusal-message'
import { translate } from '../i18n/mobile-i18n'
import { aiVaultSessionHandoffPromptRead } from './mobile-agent-history-operations'
import {
  launchAgentInExistingWorkspace,
  supportsMobileExistingAgentLaunch
} from '../session/agent-launch/mobile-existing-agent-launch'
import { AI_VAULT_SESSION_HANDOFF_RUNTIME_CAPABILITY } from '../../../src/shared/ai-vault/contracts/ai-vault-runtime-capabilities'
import type { MobileNewTabAgentOption } from '../session/agent-launch/mobile-new-tab-agent-options'
import {
  promptedAgentLaunchResult,
  type MobilePromptedAgentLaunch
} from '../session/agent-launch/mobile-prompted-agent-launch'

/** The host builds the prompt and starts the agent durably; older hosts get an update message. */
export function supportsMobileHistoryHandoff(capabilities: readonly string[] | undefined): boolean {
  return (
    capabilities?.includes(AI_VAULT_SESSION_HANDOFF_RUNTIME_CAPABILITY) === true &&
    supportsMobileExistingAgentLaunch(capabilities)
  )
}

export type MobileHistoryHandoff = {
  prompts: AiVaultSessionHandoffPrompts
  worktreeId: string
  /** Desktop's rule: the session's own directory, even when its workspace is gone. */
  cwd: string | null
}

/** The host builds desktop's prompt from the row the phone shows, saving a database row first. */
export async function prepareMobileHistoryHandoff(args: {
  client: RpcClient
  session: AiVaultSession
  worktreeId: string
}): Promise<MobileHistoryHandoff | null> {
  const { session } = args
  const reply = await aiVaultSessionHandoffPromptRead.request(
    args.client,
    {
      agent: session.agent,
      filePath: session.filePath,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      title: session.title,
      cwd: session.cwd,
      lastUserPrompt: session.lastUserPrompt ?? null,
      previewMessages: session.previewMessages.map(({ role, text }) => ({ role, text }))
    },
    // The host may read a database row first, bounded by this same budget.
    { timeoutMs: AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS + 5_000 }
  )
  const prompts = interpretOrThrowRefusalMessage(
    () => aiVaultSessionHandoffPromptRead.interpret(reply),
    translate('agentHistory.handoff.launchFailed', 'Could not start a new session.')
  )
  return prompts.focused ? { prompts, worktreeId: args.worktreeId, cwd: session.cwd } : null
}

/** Starts the picked agent in the target workspace through the host's durable launch. */
export async function launchMobileHistoryHandoff(args: {
  client: RpcClient
  hostCapabilities: readonly string[] | undefined
  handoff: MobileHistoryHandoff
  mode: AgentSessionContinuationContextMode
  option: MobileNewTabAgentOption
}): Promise<MobilePromptedAgentLaunch> {
  const { prompts, worktreeId, cwd } = args.handoff
  const text = (args.mode === 'full' ? prompts.full : undefined) ?? prompts.focused ?? ''
  const launched = await launchAgentInExistingWorkspace({
    client: args.client,
    hostCapabilities: args.hostCapabilities,
    worktreeId,
    agent: args.option.agent,
    nativeChatDefault: args.option.nativeChatDefault,
    prompt: { text, delivery: 'submit' },
    ...(cwd ? { cwd } : {}),
    launchSource: 'mobile'
  })
  return promptedAgentLaunchResult(launched, text)
}
