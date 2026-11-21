import { Pressable, Text } from 'react-native'
import { isNativeChatPastedImagePath } from '../../../../../../src/shared/native-chat/attachments/native-chat-image-label'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import {
  chatTextAttachmentName,
  isChatAttachmentStorePath
} from '../../../../../../src/shared/native-chat/attachments/native-chat-text-attachment-references'
import { shortAttachmentDisplayName } from '../../../../files/attachments/mobile-attachment-display-name'
import { mobileAttachmentExtension } from '../../../../files/attachments/mobile-attachment-file-kind'
import { MobileAttachmentFileIcon } from '../../../../files/attachments/MobileAttachmentFileIcon'
import { colors, pressedStyle } from '../../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileNativeChatOpenFile } from '../../links/mobile-native-chat-open-file-context'
import { styles } from '../messages/mobile-native-chat-message-styles'

const CHIP_NAME_MAX_CHARS = 30

/** A sent file as a named chip with its type icon; opens when the host keeps it as a chat upload. */
export function MobileNativeChatFileChip({
  path,
  pastedText
}: {
  path: string
  pastedText: string
}): React.JSX.Element {
  useMobileColorScheme()
  const onOpenFile = useMobileNativeChatOpenFile()
  const t = useMobileTranslation()
  // A paste's generated file name says nothing, so call it what it is.
  const name = isNativeChatPastedImagePath(path)
    ? t('chat.nativeChatProse.attachedImage', 'Attached image')
    : (shortAttachmentDisplayName(path, CHIP_NAME_MAX_CHARS) ??
      chatTextAttachmentName(path, pastedText))
  const extension = mobileAttachmentExtension(name)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      disabled={!onOpenFile || !isChatAttachmentStorePath(path)}
      onPress={() => onOpenFile?.(path)}
      style={({ pressed }) => [styles.sentFile, pressed && pressedStyle]}
    >
      <MobileAttachmentFileIcon name={name} size={16} color={colors.textSecondary} />
      <Text style={styles.sentFileName} numberOfLines={1}>
        {name}
      </Text>
      {extension ? <Text style={styles.sentFileType}>{extension.toUpperCase()}</Text> : null}
    </Pressable>
  )
}
