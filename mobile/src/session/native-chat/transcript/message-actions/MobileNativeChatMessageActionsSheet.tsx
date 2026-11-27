import { useContext, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Copy, GitFork, TextSelect, Trash2, X } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { ActionSheetContent } from '../../../../components/sheets/ActionSheetModal'
import { BottomDrawer } from '../../../../components/bottom-drawer/BottomDrawer'
import { useClipboardWriter } from '../../../../platform/clipboard/clipboard'
import { useWindowSafeAreaInsets } from '../../../../layout/side-safe-area'
import { colors, spacing, typography, pressedStyle } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { mobileNativeChatDisplayCopyText } from '../messages/mobile-native-chat-display-copy'
import { useMobileSlackMirrorContext } from '../../slack-mirror/use-mobile-slack-mirror'
import { MobileNativeChatForkContext } from '../../history/use-mobile-native-chat-fork'
import { useMobileNativeChatMessageTimeLabel } from '../messages/MobileNativeChatMessageTime'

const NO_SUBSCRIBE = () => () => {}

type Props = {
  message: NativeChatMessage
  onClose: () => void
}

export function MobileNativeChatMessageActionsSheet({
  message,
  onClose
}: Props): React.JSX.Element {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const [sheetVisible, setSheetVisible] = useState(true)
  const [selecting, setSelecting] = useState(false)
  // Wait for the drawer to unmount before presenting another native modal.
  const selectRequested = useRef(false)
  // Streaming updates must not reset an active native text selection.
  const [text] = useState(() => mobileNativeChatDisplayCopyText(message))
  const closeSheet = () => setSheetVisible(false)
  const mirror = useMobileSlackMirrorContext()
  const posted = mirror?.link.mirrorPosts?.[message.id]?.state === 'posted'
  const fork = useContext(MobileNativeChatForkContext)
  // Whether Fork is listed is read once, so rows never move under the finger; its enabled state stays live.
  const [forkListed] = useState(() => {
    const offer = fork?.offerFor(message)
    return offer === 'available' || offer === 'disabled'
  })
  const forkOffer = useSyncExternalStore(
    fork?.subscribe ?? NO_SUBSCRIBE,
    () => fork?.offerFor(message) ?? 'hidden'
  )
  const time = useMobileNativeChatMessageTimeLabel(message.timestamp)

  return (
    <>
      <BottomDrawer
        visible={sheetVisible}
        onClose={closeSheet}
        onAfterClose={() => (selectRequested.current ? setSelecting(true) : onClose())}
        dragContentToDismiss
      >
        <ActionSheetContent
          {...(time ? { title: time.short, titleAccessibilityLabel: time.full } : {})}
          onClose={closeSheet}
          actions={[
            {
              id: 'copyMessage',
              label: t('chat.messageActionsSheet.copyMessage', 'Copy message'),
              icon: Copy,
              disabled: text.length === 0,
              onPress: () => {
                void clipboard.writeText(text).catch((error: unknown) => {
                  Alert.alert(
                    translate('chat.messageActionsSheet.copyFailed', 'Copy failed'),
                    error instanceof Error
                      ? error.message
                      : translate(
                          'chat.messageActionsSheet.clipboardRejected',
                          'The clipboard rejected the text.'
                        )
                  )
                })
              }
            },
            {
              id: 'selectText',
              label: t('chat.messageActionsSheet.selectText', 'Select text'),
              icon: TextSelect,
              disabled: text.length === 0,
              onPress: () => {
                selectRequested.current = true
              }
            },
            ...(fork && forkListed
              ? [
                  {
                    id: 'fork',
                    label: t('chat.message.forkFromResponse', 'Fork from this response'),
                    icon: GitFork,
                    disabled: forkOffer !== 'available',
                    onPress: () => fork.fork(message)
                  }
                ]
              : []),
            ...(mirror && posted
              ? [
                  {
                    id: 'deleteFromSlack',
                    label: t('components.native-chat.slackMirror.delete', 'Delete from Slack'),
                    icon: Trash2,
                    destructive: true,
                    onPress: () => void mirror.post(message.id, 'delete')
                  }
                ]
              : [])
          ]}
        />
      </BottomDrawer>
      {selecting ? <SelectTextScreen text={text} onClose={onClose} /> : null}
    </>
  )
}

function SelectTextScreen({
  text,
  onClose
}: {
  text: string
  onClose: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useWindowSafeAreaInsets()
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View
        style={[
          styles.screen,
          {
            paddingTop: insets.top,
            paddingRight: insets.right,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left
          }
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.title}>
            {t('chat.messageActionsSheet.selectText', 'Select text')}
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityLabel={t('common.close', 'Close')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.close, pressed && pressedStyle]}
          >
            <X size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          <Text selectable style={styles.text}>
            {text}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  title: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '600' },
  close: { padding: spacing.xs },
  body: { padding: spacing.lg },
  text: { color: colors.textPrimary, fontSize: typography.bodySize, lineHeight: 22 }
}))
