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
  rowId: string | undefined
  names: MobileNativeChatNoticeView
  lineText: string
  failureDetail: string | undefined
  t: Translate
}): {
  signIn: { onPress: () => void; hint: string } | null
  shownText: string
  detail: string | undefined
  /** This row's Sign in finished: it reads as settled, as desktop's notice does. */
  signedIn: boolean
} {
  const { failure, names, lineText, failureDetail, rowId, t } = input
  const managedAgent =
    failure?.account === 'managed' ? agentSessionSetupFor(names.agentName)?.agent : undefined
  const accountSignIn = names.accountSignIn
  const onHost =
    accountSignIn && (managedAgent === 'claude' || managedAgent === 'codex')
      ? () => accountSignIn.signIn(managedAgent, rowId)
      : null
  const command =
    failure && !onHost
      ? agentSessionSignInCommand(names.agentName, { account: failure.account, remote: true })
      : null
  const runInTerminal = names.onRunInTerminal
  const failureWords = failureDetail?.trim() !== lineText.trim() ? failureDetail : undefined
  if (onHost && rowId !== undefined && accountSignIn?.signedInRow === rowId) {
    return {
      signIn: null,
      shownText: t('chat.notice.signedInSendAgain', 'Signed in. Send again.'),
      detail: undefined,
      signedIn: true
    }
  }
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
      detail: failureWords,
      signedIn: false
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
      undefined,
    signedIn: false
  }
}
