import { useRef, useState } from 'react'
import { Alert, Modal, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Copy, TextSelect } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { ActionSheetContent } from '../components/ActionSheetModal'
import { BottomDrawer } from '../components/BottomDrawer'
import { useClipboardWriter } from '../platform/clipboard'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import { SheetHeader } from '../components/ui/SheetHeader'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { nativeChatMessagePlainText } from './mobile-native-chat-message-plain-text'

type Props = {
  /** The long-pressed message. The owner mounts this only while the sheet is open. */
  message: NativeChatMessage
  onClose: () => void
}

export function MobileNativeChatMessageActionsSheet({
  message,
  onClose
}: Props): React.JSX.Element {
  const clipboard = useClipboardWriter()
  const [sheetVisible, setSheetVisible] = useState(true)
  const [selecting, setSelecting] = useState(false)
  // Wait for the drawer to unmount before presenting another native modal.
  const selectRequested = useRef(false)
  // Streaming updates must not reset an active native text selection.
  const [text] = useState(() => nativeChatMessagePlainText(message))
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
                void clipboard.writeText(text).then(triggerSuccess, () => {
                  triggerError()
                  Alert.alert("Couldn't copy the message", 'Use Select text to copy part of it.')
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
          <SheetHeader title="Select text" trailing={{ label: 'Done', onPress: onClose }} />
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator
  },
  body: { padding: spacing.lg },
  text: { ...textStyles.body, color: colors.textPrimary }
})
