// A not-signed-in notice's Sign in: a managed Claude or Codex account signs in again on its host through
// the Accounts sheet; the agent's own login runs its login command in a host terminal.
import type { AgentSessionFailureFact } from '../../../../../../src/shared/agent-session/failures/agent-session-failure'
import {
  agentSessionSetupFor,
  agentSessionSignInCommand
} from '../../../../../../src/shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { Translate } from '../../../../i18n/mobile-i18n'
import type { MobileNativeChatNoticeView } from './mobile-native-chat-notice-context'

export function nativeChatNoticeSignIn(input: {
  /** The row's unresolved not-signed-in failure, or null. */
  failure: AgentSessionFailureFact | null
  names: MobileNativeChatNoticeView
  lineText: string
  failureDetail: string | undefined
  t: Translate
}): {
  signIn: { onPress: () => void; hint: string } | null
  shownText: string
  detail: string | undefined
} {
  const { failure, names, lineText, failureDetail, t } = input
  const managedAgent =
    failure?.account === 'managed' ? agentSessionSetupFor(names.agentName)?.agent : undefined
  const signInAccount = names.signInAccount
  const onHost =
    signInAccount && (managedAgent === 'claude' || managedAgent === 'codex')
      ? () => signInAccount(managedAgent)
      : null
  const command =
    failure && !onHost
      ? agentSessionSignInCommand(names.agentName, { account: failure.account, remote: true })
      : null
  const runInTerminal = names.onRunInTerminal
  const failureWords = failureDetail?.trim() !== lineText.trim() ? failureDetail : undefined
  if (!onHost) {
    return {
      signIn:
        command && runInTerminal
          ? {
              onPress: () => runInTerminal(command),
              hint: t(
                'chat.notice.signInHint',
                'Opens a terminal on the computer running this chat'
              )
            }
          : null,
      shownText: lineText,
      detail: failureWords
    }
  }
  // One sentence says what's wrong; the host's longer words stay under Details.
  const shownText = t('chat.notice.notSignedIn', "{{agent}} isn't signed in.", {
    agent: names.agentName ?? ''
  })
  const hostWords = lineText.trim() !== shownText ? lineText : undefined
  return {
    signIn: {
      onPress: onHost,
      hint: t(
        'chat.notice.signInAccountHint',
        'Signs this account in again on the computer running this chat'
      )
    },
    shownText,
    detail:
      [hostWords, failureWords].filter((words): words is string => Boolean(words)).join('\n\n') ||
      undefined
  }
}
