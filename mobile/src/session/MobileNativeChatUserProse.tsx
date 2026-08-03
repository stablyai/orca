import { Fragment } from 'react'
import { Text } from 'react-native'
import { detectFilePathSegments } from '../components/markdown-file-path-detection'
import type { MobileFileTapTarget } from '../files/mobile-file-tap-target'
import { styles, TEXT_SIZE } from './mobile-native-chat-message-styles'

export function MobileNativeChatUserProse({
  text,
  fontScale,
  onOpenFile
}: {
  text: string
  fontScale: number
  onOpenFile?: (target: MobileFileTapTarget) => void
}): React.JSX.Element {
  const segments = onOpenFile
    ? detectFilePathSegments(text)
    : [{ type: 'text' as const, value: text }]
  let offset = 0
  const keyedSegments = segments.map((segment) => {
    const key = `${offset}:${segment.type}`
    offset += segment.value.length
    return { key, segment }
  })
  return (
    <Text style={[styles.userText, { fontSize: TEXT_SIZE * fontScale }]}>
      {keyedSegments.map(({ key, segment }) =>
        segment.type === 'file' ? (
          <Text
            key={key}
            style={styles.userFileLink}
            onPress={() => onOpenFile?.(segment.target)}
            accessibilityRole="link"
            accessibilityLabel={`Open file ${segment.target.pathText}`}
          >
            {segment.value}
          </Text>
        ) : (
          <Fragment key={key}>{segment.value}</Fragment>
        )
      )}
    </Text>
  )
}
