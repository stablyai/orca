import type React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { BookOpen, Code, ListOrdered } from 'lucide-react-native'
import { MobileSourceCopyButton } from './MobileSourceCopyButton'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export type MobileFileAddressToolbarProps = {
  path: string
  showLineNumbers?: boolean
  onToggleLineNumbers?: () => void
  viewMode?: 'preview' | 'source'
  onViewModeChange?: (mode: 'preview' | 'source') => void
  content?: string
  truncated?: boolean
  copyAccessibilityLabel?: string
  leadingActions?: React.ReactNode
  trailingActions?: React.ReactNode
}

export function MobileFileAddressToolbar({
  path,
  showLineNumbers,
  onToggleLineNumbers,
  viewMode,
  onViewModeChange,
  content,
  truncated,
  copyAccessibilityLabel,
  leadingActions,
  trailingActions
}: MobileFileAddressToolbarProps): React.JSX.Element {
  const canShowLineNumbers = Boolean(onToggleLineNumbers && viewMode !== 'preview')
  const sourceSelected = viewMode === 'source'
  const previewSelected = viewMode === 'preview'

  return (
    <View style={styles.toolbar}>
      <View style={styles.leading}>
        {canShowLineNumbers ? (
          <Pressable
            style={[styles.button, showLineNumbers && styles.buttonActive]}
            onPress={onToggleLineNumbers}
            accessibilityRole="button"
            accessibilityState={{ selected: showLineNumbers }}
            accessibilityLabel={showLineNumbers ? 'Hide line numbers' : 'Show line numbers'}
          >
            <ListOrdered
              size={15}
              color={showLineNumbers ? colors.textPrimary : colors.textSecondary}
              strokeWidth={2.2}
            />
          </Pressable>
        ) : null}
        {viewMode && onViewModeChange ? (
          <View style={styles.modeSegment}>
            <Pressable
              style={[styles.modeToggle, sourceSelected && styles.modeToggleActive]}
              onPress={() => onViewModeChange('source')}
              accessibilityRole="button"
              accessibilityState={{ selected: sourceSelected }}
              accessibilityLabel="View Markdown source"
            >
              <Code
                size={15}
                color={sourceSelected ? colors.textPrimary : colors.textSecondary}
                strokeWidth={2.2}
              />
            </Pressable>
            <Pressable
              style={[styles.modeToggle, previewSelected && styles.modeToggleActive]}
              onPress={() => onViewModeChange('preview')}
              accessibilityRole="button"
              accessibilityState={{ selected: previewSelected }}
              accessibilityLabel="View rendered Markdown preview"
            >
              <BookOpen
                size={15}
                color={previewSelected ? colors.textPrimary : colors.textSecondary}
                strokeWidth={2.2}
              />
            </Pressable>
          </View>
        ) : null}
        {leadingActions}
      </View>
      <Text style={styles.path} numberOfLines={1}>
        {path}
      </Text>
      <View style={styles.trailing}>
        {content !== undefined ? (
          <MobileSourceCopyButton
            key={path}
            text={content}
            partial={truncated}
            accessibilityLabel={copyAccessibilityLabel ?? 'Copy file content'}
          />
        ) : null}
        {trailingActions}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  leading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  path: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500',
    marginHorizontal: spacing.sm
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  button: {
    width: 30,
    height: 30,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  buttonActive: {
    backgroundColor: colors.bgRaised,
    borderColor: colors.accentBlue
  },
  modeSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  modeToggle: {
    width: 30,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.row,
    backgroundColor: 'transparent',
    opacity: 0.72
  },
  modeToggleActive: {
    backgroundColor: colors.bgPanel,
    opacity: 1
  }
})
