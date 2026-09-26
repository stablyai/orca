import { useRef, useState } from 'react'
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Copy, TextSelect, X } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { ActionSheetContent } from '../components/ActionSheetModal'
import { BottomDrawer } from '../components/BottomDrawer'
import { useClipboardWriter } from '../platform/clipboard'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { nativeChatMessagePlainText } from './mobile-native-chat-message-plain-text'

type Props = {
  /** The long-pressed message. The owner mounts this only while the sheet is open. */
  message: NativeChatMessage
  onClose: () => void
}

/** Long-press actions for a transcript message where inline selection is off (Android): copy the
 *  whole message, or open a screen whose only job is selecting text, so a stray selection can
 *  never start while the transcript scrolls. */
export function MobileNativeChatMessageActionsSheet({
  message,
  onClose
}: Props): React.JSX.Element {
  const clipboard = useClipboardWriter()
  const [sheetVisible, setSheetVisible] = useState(true)
  const [selecting, setSelecting] = useState(false)
  // Why deferred: a second native Modal must not be presented while the drawer's own modal is
  // still closing, so "Select text" only marks the intent and the drawer's after-close opens it.
  const selectRequested = useRef(false)
  const text = nativeChatMessagePlainText(message)
  const closeSheet = () => setSheetVisible(false)

  return (
    <>
      <BottomDrawer
        visible={sheetVisible}
        onClose={closeSheet}
        onAfterClose={() => (selectRequested.current ? setSelecting(true) : onClose())}
        dragContentToDismiss
      >
        <ActionSheetContent
          onClose={closeSheet}
          actions={[
            {
              label: 'Copy message',
              icon: Copy,
              disabled: text.length === 0,
              onPress: () => {
                void clipboard.writeText(text).catch((error: unknown) => {
                  Alert.alert(
                    'Copy failed',
                    error instanceof Error ? error.message : 'The clipboard rejected the text.'
                  )
                })
              }
            },
            {
              label: 'Select text',
              icon: TextSelect,
              disabled: text.length === 0,
              onPress: () => {
                selectRequested.current = true
              }
            }
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
  const insets = useSafeAreaInsets()
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Select text</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close" style={styles.close}>
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

const styles = StyleSheet.create({
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
})
