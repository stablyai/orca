import { memo, useMemo } from 'react'
import { Text } from 'react-native'
import {
  nativeChatTextAttachmentPaths,
  chatTextAttachmentName
} from '../../../../../src/shared/native-chat-text-attachment-references'
import { useMobileNativeChatOpenFile } from '../mobile-native-chat-open-file-context'
import { styles } from './mobile-native-chat-message-styles'

export const TextAttachmentActions = memo(function TextAttachmentActions(props: {
  text: string
  pastedText: string
}) {
  const { text, pastedText } = props
  const onOpenFile = useMobileNativeChatOpenFile()
  const paths = useMemo(() => nativeChatTextAttachmentPaths(text), [text])
  return paths.map((path) => (
    <Text
      key={path}
      accessibilityRole="button"
      onPress={() => onOpenFile?.(path)}
      style={styles.agentAttribution}
    >
      {chatTextAttachmentName(path, pastedText)}
    </Text>
  ))
})
