import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import {
  NATIVE_CHAT_TURN_DIFF_FILE_LIMIT,
  nativeChatTurnDiffEditFile,
  type NativeChatTurnDiff,
  type NativeChatTurnDiffFile
} from '../../../../../src/shared/native-chat/tools/native-chat-turn-diffs'
import { MobileNativeChatDiffCard } from '../MobileNativeChatDiffCard'
import { useMobileNativeChatDisclosure } from './mobile-native-chat-disclosure-store'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { colors, pressedStyle, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { toolType } from './mobile-native-chat-tool-styles'

function FileRow({
  file,
  fontScale,
  onOpenFile
}: {
  file: NativeChatTurnDiffFile
  fontScale: number
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useMobileNativeChatDisclosure(
    `turn-diff:${file.edits[0]?.target.messageId}:${file.path}`,
    false
  )
  const type = toolType(fontScale)
  return (
    <View>
      <Pressable
        style={({ pressed }) => [styles.file, pressed && pressedStyle]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <ChevronRight
          size={14 * fontScale}
          color={colors.textMuted}
          style={open ? styles.open : undefined}
        />
        <Text style={[styles.path, type.meta]} numberOfLines={1}>
          {file.path}
        </Text>
        <Text style={[styles.added, type.meta]}>+{file.added}</Text>
        <Text style={[styles.removed, type.meta]}>-{file.removed}</Text>
      </Pressable>
      {open
        ? file.edits.map((edit) => {
            const patch = nativeChatTurnDiffEditFile(edit)
            const key = `turn-diff-card:${edit.target.messageId}:${edit.target.editKey}:${edit.fileIndex}`
            return patch ? (
              <MobileNativeChatDiffCard
                key={key}
                file={patch}
                fontScale={fontScale}
                initialOpen
                disclosureKey={key}
                rootIdentity={key}
                onOpenFile={onOpenFile}
              />
            ) : null
          })
        : null}
    </View>
  )
}

export function MobileNativeChatTurnDiffRollup({
  diff,
  fontScale,
  onOpenFile
}: {
  diff: NativeChatTurnDiff
  fontScale: number
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [showAll, setShowAll] = useMobileNativeChatDisclosure(
    `turn-diff-files:${diff.files[0]?.edits[0]?.target.messageId}`,
    false
  )
  const files = showAll ? diff.files : diff.files.slice(0, NATIVE_CHAT_TURN_DIFF_FILE_LIMIT)
  const remaining = diff.files.length - files.length
  const type = toolType(fontScale)
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={[styles.label, type.meta]}>
          {t('components.native-chat.turnDiff.changedFiles', '{{count}} changed files', {
            count: diff.files.length,
            defaultValue_one: '{{count}} changed file'
          })}
        </Text>
        <Text style={[styles.added, type.meta]}>+{diff.added}</Text>
        <Text style={[styles.removed, type.meta]}>-{diff.removed}</Text>
        {diff.truncated ? (
          <Text style={[styles.label, type.meta]}>
            {t('components.native-chat.turnDiff.partial', 'Partial diff')}
          </Text>
        ) : null}
      </View>
      {files.map((file) => (
        <FileRow key={file.path} file={file} fontScale={fontScale} onOpenFile={onOpenFile} />
      ))}
      {remaining > 0 ? (
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.file, pressed && pressedStyle]}
          onPress={() => setShowAll(true)}
        >
          <Text style={[styles.label, type.meta]}>
            {t('components.native-chat.turnDiff.showMoreFiles', 'Show {{count}} more files', {
              count: remaining
            })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    padding: spacing.sm,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
    gap: spacing.xs
  },
  header: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm
  },
  path: { flexShrink: 1, color: colors.textPrimary },
  label: { color: colors.textMuted },
  added: { color: colors.gitDecorationAdded },
  removed: { color: colors.gitDecorationDeleted },
  open: { transform: [{ rotate: '90deg' }] }
}))
