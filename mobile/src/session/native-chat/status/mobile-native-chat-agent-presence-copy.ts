import { useMemo } from 'react'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { MobileNativeChatController } from '../mobile-native-chat-controller-contract'
import { formatAgentTypeLabel } from '../../../../../src/shared/agent-status/presentation/agent-type-label'
import {
  isNativeChatRestartNewConversation,
  type NativeChatAgentPresence
} from '../../../../../src/shared/native-chat/agent-presence/native-chat-agent-presence'

export type MobileNativeChatAgentNotice = {
  text: string
  action: { label: string; onPress: () => void } | null
}

/** The line above the composer for an agent that exited from, or came back to, the chat's terminal. */
export function mobileNativeChatAgentNotice(args: {
  presence: NativeChatAgentPresence
  agent: string
  sessionId: string | null
  onShowTerminal: (() => void) | undefined
  onDismissRestart: () => void
  t: Translate
}): MobileNativeChatAgentNotice | null {
  const { presence, t } = args
  const agent = formatAgentTypeLabel(args.agent)
  if (presence.exit) {
    return {
      // The host's presence read carries no exit code, so the phone names none.
      text: t(
        'chat.agentPresence.exited',
        '{{agent}} is no longer running in this terminal. Sending is paused so nothing is typed into the shell.',
        { agent }
      ),
      action: args.onShowTerminal
        ? {
            label: t('session.nativeChatToggleAction.switchToTerminalView', 'Switch to terminal'),
            onPress: args.onShowTerminal
          }
        : null
    }
  }
  if (!presence.restartFrom) {
    return null
  }
  return {
    text: isNativeChatRestartNewConversation(presence.restartFrom, args.sessionId)
      ? t(
          'chat.agentPresence.restartedNewSession',
          '{{agent}} restarted in a new session. Earlier messages are not part of its context.',
          { agent }
        )
      : t('chat.agentPresence.runningAgain', '{{agent}} is running again.', { agent }),
    action: { label: t('common.ok', 'OK'), onPress: args.onDismissRestart }
  }
}

/** The chat's agent notice in the reader's language; Switch opens this chat's terminal view. */
export function useMobileNativeChatAgentNotice(
  controller: Pick<
    MobileNativeChatController,
    'nativeChatAgentPresence' | 'nativeChatAgent' | 'setTabView'
  >,
  activeSessionTabId: string | null | undefined,
  sessionId: string | null
): MobileNativeChatAgentNotice | null {
  const t = useMobileTranslation()
  const { nativeChatAgentPresence: tracked, nativeChatAgent, setTabView } = controller
  return useMemo(
    () =>
      tracked
        ? mobileNativeChatAgentNotice({
            presence: tracked.presence,
            agent: nativeChatAgent ?? '',
            sessionId,
            onShowTerminal: activeSessionTabId
              ? () => setTabView(activeSessionTabId, 'terminal')
              : undefined,
            onDismissRestart: tracked.dismissRestart,
            t
          })
        : null,
    [tracked, nativeChatAgent, sessionId, activeSessionTabId, setTabView, t]
  )
}
