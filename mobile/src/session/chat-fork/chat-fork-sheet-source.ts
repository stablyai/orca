import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent-config'
import {
  buildChatForkRecap,
  type ChatForkRecapScope
} from '../../../../src/shared/agent-session/context/chat-fork-recap'
import { AI_VAULT_CHAT_FORK_EXPORT_CAPABILITY } from '../../../../src/shared/ai-vault/resume/ai-vault-resume-preparation'
import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import { mobileSubagentForkAvailable } from '../mobile-structured-chat-worktree-fork'
import type { MobileNativeChatFork } from '../native-chat/history/use-mobile-native-chat-fork'
import type { MobileSessionController } from '../use-mobile-session-controller'
import type { MobileChatForkSheetSource } from './MobileChatForkSheet'

/** What the open chat can fork as; null when its agent can't fork. */
export function chatForkSheetSource(
  controller: MobileSessionController,
  fork: MobileNativeChatFork,
  executionHost: ExecutionHostId | undefined
): MobileChatForkSheetSource | null {
  const agent = controller.nativeChatController.nativeChatAgent
  if (!agent || !isTuiAgent(agent)) {
    return null
  }
  const capabilities = controller.hostCapabilities
  const terminal = controller.activeSessionTab?.type === 'terminal'
  return {
    hostId: controller.hostId,
    worktreeId: controller.worktreeId,
    client: controller.client,
    capabilities,
    agent,
    surface: terminal ? 'terminal' : 'chat',
    usageLimited: controller.nativeChatController.nativeChatUsageLimit !== null,
    // A workspace routed to another server exports from there; this phone can't reach it directly.
    canExport:
      !executionHost &&
      agent === 'claude' &&
      capabilities?.includes(AI_VAULT_CHAT_FORK_EXPORT_CAPABILITY) === true,
    canCopy: fork.copyOffered(),
    canNewWorktree: fork.worktreeForkOffered(),
    canSubagent: !terminal && mobileSubagentForkAvailable(capabilities)
  }
}

/** The open chat's recap up to a fork point, read from its transcript as it is now. */
export function chatForkRecapOf(
  controller: MobileSessionController,
  agent: TuiAgent
): (scope: ChatForkRecapScope, throughItemId: string) => string | null {
  return (scope, throughItemId) =>
    buildChatForkRecap({
      messages: controller.nativeChatController.nativeChatSession.messages,
      throughItemId,
      scope,
      sourceAgent: agent,
      sourceTitle: controller.activeSessionTab?.title || undefined
    })
}
