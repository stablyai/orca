import type { Translate } from '../../../i18n/mobile-i18n'
import type { PaneAgentRestartRefusal } from '../../../../../src/shared/native-chat/agent-presence/pane-agent-restart-contract'

/** Why a Resume or Start new session did not bring the agent back. */
export function mobileNativeChatAgentRestartFailureText(
  reason: PaneAgentRestartRefusal,
  agent: string,
  t: Translate
): string {
  switch (reason) {
    case 'no_resume':
      return t(
        'chat.agentPresence.failed.noResume',
        'Orca has no {{agent}} session to resume in this terminal. Start a new session instead.',
        { agent }
      )
    case 'held_elsewhere':
      return t(
        'chat.agentPresence.failed.heldElsewhere',
        'Another terminal is already running this {{agent}} session.',
        { agent }
      )
    case 'pane_unavailable':
      return t(
        'chat.agentPresence.failed.paneUnavailable',
        'This terminal is not open in an Orca window on your computer, so {{agent}} cannot be restarted in it.',
        { agent }
      )
    case 'no_launch_command':
      return t(
        'chat.agentPresence.failed.noLaunchCommand',
        'Orca could not build a command to start {{agent}} here.',
        { agent }
      )
    case 'failed':
      return t(
        'chat.agentPresence.failed.didNotStart',
        '{{agent}} did not start. Check the terminal, then try again.',
        { agent }
      )
  }
}
