import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { MobileSegmentedControl, type MobileSegment } from './MobileSegmentedControl'

export type MobilePreviewMode = 'preview' | 'source'

const MODE_SEGMENTS: readonly MobileSegment<MobilePreviewMode>[] = [
  { value: 'preview', label: 'Preview' },
  { value: 'source', label: 'Source' }
]

type Props = {
  /** Shows the Preview | Source switch; omitted for kinds with only one view. */
  mode?: MobilePreviewMode
  onModeChange?: (mode: MobilePreviewMode) => void
  /** Quiet text on the leading side when there is no switch, e.g. "312 lines". */
  caption?: string
  /** The trailing action, usually Copy. */
  trailing?: ReactNode
  testIDPrefix?: string
}

/** The one toolbar above a file's contents: the view switch on the left, Copy on the right. */
export function MobilePreviewModeToolbar({
  mode,
  onModeChange,
  caption,
  trailing,
  testIDPrefix
}: Props) {
  return (
    <View style={styles.toolbar}>
      {mode !== undefined && onModeChange ? (
        <MobileSegmentedControl
          segments={MODE_SEGMENTS}
          selected={mode}
          onSelect={onModeChange}
          testIDPrefix={testIDPrefix}
        />
      ) : caption !== undefined ? (
        <Text style={styles.caption} numberOfLines={1}>
          {caption}
        </Text>
      ) : null}
      <View style={styles.spacer} />
      {trailing}
    </View>
  )
}

const styles = StyleSheet.create({
  toolbar: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    backgroundColor: colors.bgBase,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator
  },
  caption: {
    ...textStyles.footnote,
    flexShrink: 1,
    minWidth: 0,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  spacer: { flex: 1 }
})
