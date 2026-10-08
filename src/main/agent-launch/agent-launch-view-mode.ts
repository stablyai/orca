/**
 * Which view a terminal agent tab opens in — the terminal itself or its chat view — decided on the
 * host by the rule the window applies to a tab it creates, so a launch from the phone, the CLI or the
 * window opens the same way. Never a caller field.
 */

import type { AgentLaunchPrompt } from '../../shared/agent-launch-intent'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { decideInitialAgentTabViewMode } from '../../shared/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '../../shared/native-chat-transcript-readability'
import type { TuiAgent } from '../../shared/tui-agent'

export type AgentLaunchTerminalViewMode = 'terminal' | 'chat'

/** Always explicit: an absent view lets the window re-derive it without the prompt's delivery. */
export function deriveAgentLaunchTerminalViewMode(args: {
  settings: Partial<
    Pick<GlobalSettings, 'experimentalNativeChat' | 'openAgentTabsInChatByDefault'>
  > | null
  agent: TuiAgent
  prompt?: AgentLaunchPrompt
  /** The workspace's SSH connection; `null` is local. */
  connectionId: string | null | undefined
}): AgentLaunchTerminalViewMode {
  const viewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: args.settings?.experimentalNativeChat,
    openAgentTabsInChatByDefault: args.settings?.openAgentTabsInChatByDefault,
    agent: args.agent,
    ...(args.prompt
      ? {
          promptDelivery: args.prompt.delivery === 'draft' ? 'draft' : 'auto-submit',
          launchDraftText: args.prompt.text
        }
      : {}),
    nativeChatTranscriptIsLocalReadable:
      args.connectionId !== undefined && isNativeChatTranscriptLocalReadable(args.connectionId)
  })
  return viewMode === 'chat' ? 'chat' : 'terminal'
}
