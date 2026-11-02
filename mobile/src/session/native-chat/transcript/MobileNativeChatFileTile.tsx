import { FileText } from 'lucide-react-native'
import { useContext, useEffect, useState } from 'react'
import { Image, Pressable, Text } from 'react-native'
import { getRuntimePathBasename } from '../../../../../src/shared/cross-platform-path'
import { usePdfThumbnailer } from '../../../platform/pdf-thumbnail'
import { colors, pressedStyle } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { styles as messageStyles } from './mobile-native-chat-message-styles'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'

// A document the user shared, drawn where photos sit: a PDF's first page when the shell can render it,
// otherwise its name. Tapping opens it like any mentioned file.
export function MobileNativeChatFileTile({
  path,
  onOpenFile,
  onLongPress
}: {
  path: string
  onOpenFile?: (relativePath: string) => void
  onLongPress?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const worktreeId = useContext(MobileNativeChatRowOverlaysContext).imageSource?.worktreeId
  const thumbnailer = usePdfThumbnailer()
  const [page, setPage] = useState<{ path: string; uri: string } | null>(null)
  const isPdf = /\.pdf$/i.test(path)
  useEffect(() => {
    if (!isPdf || !thumbnailer || !worktreeId) {
      return
    }
    let live = true
    void thumbnailer(worktreeId, path).then((uri) => {
      if (live && uri) {
        setPage({ path, uri })
      }
    })
    return () => {
      live = false
    }
  }, [isPdf, path, thumbnailer, worktreeId])
  const name = getRuntimePathBasename(path)
  return (
    <Pressable
      style={({ pressed }) => [messageStyles.imageThumb, styles.tile, pressed && pressedStyle]}
      onPress={onOpenFile ? () => onOpenFile(path) : undefined}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={name}
    >
      {page?.path === path ? (
        <Image source={{ uri: page.uri }} style={styles.page} resizeMode="cover" />
      ) : (
        <FileText size={28} color={colors.textSecondary} strokeWidth={1.75} />
      )}
      <Text style={styles.name} numberOfLines={1}>
        {name}
      </Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  tile: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  page: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  name: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised
  }
}))
