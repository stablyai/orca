import { useMemo } from 'react'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { MobileNativeChatController } from '../mobile-native-chat-controller-contract'
import { formatAgentTypeLabel } from '../../../../../src/shared/agent-status/presentation/agent-type-label'
import {
  isNativeChatRestartNewConversation,
  type NativeChatAgentPresence
} from '../../../../../src/shared/native-chat/agent-presence/native-chat-agent-presence'
import type { MobileNativeChatAgentRestart } from './use-mobile-native-chat-agent-restart'
import { mobileNativeChatAgentRestartFailureText } from './mobile-native-chat-agent-restart-copy'

export type MobileNativeChatAgentNoticeAction = {
  label: string
  onPress: () => void
  primary?: boolean
  disabled?: boolean
}

export type MobileNativeChatAgentNotice = {
  text: string
  actions: MobileNativeChatAgentNoticeAction[]
}

/** The line above the composer for an agent that exited from, or came back to, the chat's terminal. */
export function mobileNativeChatAgentNotice(args: {
  presence: NativeChatAgentPresence
  agent: string
  sessionId: string | null
  onShowTerminal: (() => void) | undefined
  onDismissRestart: () => void
  restart?: MobileNativeChatAgentRestart
  t: Translate
}): MobileNativeChatAgentNotice | null {
  const { presence, restart, t } = args
  const agent = formatAgentTypeLabel(args.agent)
  const phase = restart?.phase ?? { kind: 'idle' }
  const failure =
    phase.kind === 'failed' ? mobileNativeChatAgentRestartFailureText(phase.reason, agent, t) : null
  const restarting = phase.kind === 'restarting'
  const progress = restarting
    ? phase.mode === 'resume'
      ? t('chat.agentPresence.resuming', 'Resuming {{agent}}…', { agent })
      : t('chat.agentPresence.starting', 'Starting a new {{agent}} session…', { agent })
    : null
  if (presence.exit) {
    const showTerminal = args.onShowTerminal
      ? [
          {
            label: t('session.nativeChatToggleAction.switchToTerminalView', 'Switch to terminal'),
            onPress: args.onShowTerminal
          }
        ]
      : []
    const resume = {
      label: t('chat.agentPresence.resumeSession', 'Resume session'),
      onPress: () => restart?.restart('resume'),
      primary: true,
      disabled: restarting
    }
    const fresh = {
      label: t('chat.agentPresence.startNewSession', 'Start new session'),
      onPress: () => restart?.restart('fresh'),
      primary: !restart?.canResume,
      disabled: restarting
    }
    return {
      text:
        progress ??
        failure ??
        // The host's presence read carries no exit code, so the phone names none.
        t(
          'chat.agentPresence.exited',
          '{{agent}} is no longer running in this terminal. Sending is paused so nothing is typed into the shell.',
          { agent }
        ),
      actions: restart
        ? [...(restart.canResume ? [resume] : []), fresh, ...showTerminal]
        : showTerminal
    }
  }
  if (!presence.restartFrom) {
    return null
  }
  const newConversation = isNativeChatRestartNewConversation(presence.restartFrom, args.sessionId)
  return {
    text:
      progress ??
      failure ??
      (newConversation
        ? t(
            'chat.agentPresence.restartedNewSession',
            '{{agent}} restarted in a new session. Earlier messages are not part of its context.',
            { agent }
          )
        : t('chat.agentPresence.runningAgain', '{{agent}} is running again.', { agent })),
    actions: [
      ...(newConversation && restart?.canResume
        ? [
            {
              label: t('chat.agentPresence.resumePreviousSession', 'Resume previous session'),
              onPress: () => restart.restart('resume'),
              disabled: restarting
            }
          ]
        : []),
      { label: t('common.ok', 'OK'), onPress: args.onDismissRestart }
    ]
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
            restart: tracked.restart,
            t
          })
        : null,
    [tracked, nativeChatAgent, sessionId, activeSessionTabId, setTabView, t]
  )
}
