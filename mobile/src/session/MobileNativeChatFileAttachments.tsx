import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { FileText } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-message-styles'

export function MobileNativeChatFileAttachments({
  files,
  onOpenFile
}: {
  files: readonly string[]
  onOpenFile?: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <View style={[styles.imageGallery, expanded && styles.fileGallery]}>
      {(expanded ? files : files.slice(0, 3)).map((path) => {
        const name = path.split(/[\\/]/).at(-1) ?? path
        return (
          <Pressable
            key={path}
            accessibilityRole="button"
            accessibilityLabel={`Open file ${name}`}
            disabled={!onOpenFile}
            style={[styles.imageGalleryTile, styles.fileTile]}
            onPress={() => onOpenFile?.(path)}
          >
            <FileText size={20} color={colors.textSecondary} />
            <Text numberOfLines={2} ellipsizeMode="middle" style={styles.fileName}>
              {name}
            </Text>
          </Pressable>
        )
      })}
      {files.length > 3 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Show fewer files' : `View all ${files.length} files`}
          style={[styles.imageGalleryTile, styles.imageGalleryMore]}
          onPress={() => setExpanded(!expanded)}
        >
          <Text style={styles.imageGalleryCount}>{expanded ? '−' : `+${files.length - 3}`}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
