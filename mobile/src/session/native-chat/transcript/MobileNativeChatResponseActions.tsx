import { useContext, useSyncExternalStore } from 'react'
import { Pressable, View } from 'react-native'
import { GitBranchPlus, GitFork } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { MobileSourceCopyButton } from '../../../components/MobileSourceCopyButton'
import { colors, radii } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  MobileNativeChatForkContext,
  type MobileNativeChatForkOffer
} from '../use-mobile-native-chat-fork'

const NO_FORK = { subscribe: () => () => {}, offer: (): MobileNativeChatForkOffer => 'hidden' }

/** Copy and fork under a chat turn; fork sits where copy is, the place a phone user taps. */
export function MobileNativeChatResponseActions({
  message,
  copyText
}: {
  message: NativeChatMessage
  copyText: string
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const fork = useContext(MobileNativeChatForkContext)
  // Selected per row: a streamed revision re-renders only rows whose own offer changed.
  const offer = useSyncExternalStore(
    fork?.subscribe ?? NO_FORK.subscribe,
    fork ? () => fork.offerFor(message) : NO_FORK.offer
  )
  if (copyText.length === 0 && offer === 'hidden') {
    return null
  }
  return (
    <View style={styles.actions}>
      {copyText.length > 0 ? (
        <MobileSourceCopyButton
          key={message.id}
          text={copyText}
          accessibilityLabel={t('chat.message.copyMessage', 'Copy message')}
        />
      ) : null}
      {fork && offer !== 'hidden' ? (
        <ForkButton offer={offer} onFork={() => fork.fork(message)} />
      ) : null}
      {fork && offer !== 'hidden' && offer !== 'reserved' && fork.worktreeForkOffered() ? (
        <ForkButton offer={offer} worktree onFork={() => fork.forkToWorktree(message)} />
      ) : null}
    </View>
  )
}

/** One fork action under a response: beside this chat, or into a new worktree. */
function ForkButton({
  offer,
  worktree = false,
  onFork
}: {
  offer: Exclude<MobileNativeChatForkOffer, 'hidden'>
  /** Forks into a new worktree instead of beside this chat. */
  worktree?: boolean
  onFork: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  // Kept empty while the turn runs or the chat can't fork, so nothing beside it moves.
  if (offer === 'reserved') {
    return <View style={styles.button} />
  }
  // Disabled while the host is still asked, or while a fork from this chat opens.
  const disabled = offer === 'disabled'
  return (
    <Pressable
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={
        worktree
          ? t('chat.message.forkIntoWorktree', 'Fork into a new worktree')
          : t('chat.message.forkFromResponse', 'Fork from this response')
      }
      accessibilityHint={
        worktree
          ? t(
              'chat.message.forkIntoWorktreeHint',
              'A new worktree with a chat holding this whole response, up to the end of its turn'
            )
          : t(
              'chat.message.forkFromResponseHint',
              'A new chat with this whole response, up to the end of its turn'
            )
      }
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onFork}
    >
      {worktree ? (
        <GitBranchPlus
          size={14}
          color={colors.textMuted}
          style={disabled ? styles.disabled : null}
        />
      ) : (
        <GitFork size={14} color={colors.textMuted} style={disabled ? styles.disabled : null} />
      )}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  actions: {
    flexDirection: 'row'
  },
  button: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  pressed: { backgroundColor: colors.bgRaised },
  disabled: { opacity: 0.4 }
}))
