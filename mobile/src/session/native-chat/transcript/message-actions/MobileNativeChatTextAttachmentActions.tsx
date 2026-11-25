import { memo, useMemo } from 'react'
import { View } from 'react-native'
import { nativeChatUploadedFilePaths } from '../../../../../../src/shared/native-chat/attachments/native-chat-text-attachment-references'
import { styles } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatFileChip } from './MobileNativeChatFileChip'

// A sent message draws each uploaded file as a chip, so videos, archives and documents show by name and type.
export const TextAttachmentActions = memo(function TextAttachmentActions(props: {
  text: string
  pastedText: string
}) {
  const { text, pastedText } = props
  const paths = useMemo(() => nativeChatUploadedFilePaths(text), [text])
  if (paths.length === 0) {
    return null
  }
  return (
    <View style={styles.sentFiles}>
      {paths.map((path) => (
        <MobileNativeChatFileChip key={path} path={path} pastedText={pastedText} />
      ))}
    </View>
  )
})
