import { Alert } from 'react-native'
import { translate } from '../../i18n/mobile-i18n'
import type { MobileWorktreeForkMode } from '../mobile-structured-chat-worktree-fork'

/** One Fork button, one list of every fork: a new chat here, a new worktree, or a background subagent. */
export function chooseMobileFork(choice: {
  inChat: () => void
  intoWorktree: (mode: MobileWorktreeForkMode) => void
  subagent: boolean
}): void {
  Alert.alert(
    translate('chat.fork.choose.title', 'Fork from this response'),
    undefined,
    [
      { text: translate('chat.fork.choose.inChat', 'In a new chat'), onPress: choice.inChat },
      {
        text: translate('chat.fork.choose.worktree', 'Into a new worktree'),
        onPress: () => choice.intoWorktree('worktree')
      },
      ...(choice.subagent
        ? [
            {
              text: translate('chat.fork.choose.subagent', 'As a background subagent'),
              onPress: () => choice.intoWorktree('subagent')
            }
          ]
        : []),
      { text: translate('chat.fork.worktree.cancel', 'Cancel'), style: 'cancel' as const }
    ],
    { cancelable: true }
  )
}
