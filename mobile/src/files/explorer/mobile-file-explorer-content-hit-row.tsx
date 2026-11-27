import { Pressable, Text } from 'react-native'
import { searchMatchLineParts } from '../../../../src/shared/file-search/search-match-line-parts'
import { SectionHeader } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import type { ContentHitNode } from './file-tree'
import { fileExplorerStylesSheet } from './mobile-file-explorer-styles'

/** The label over hits inside files, under the name matches. */
export function MobileFileExplorerContentSection() {
  const t = useMobileTranslation()
  return <SectionHeader title={t('files.fileExplorerPanel.inFiles', 'In files')} />
}

/** One matched line, under its file's row: tapping opens the file at that line. */
export function MobileFileExplorerContentHitRow(props: {
  item: ContentHitNode
  onOpen: (relativePath: string, name: string, at: { line: number; column: number }) => void
}) {
  const styles = useThemedStyles(fileExplorerStylesSheet)
  const hitStyles = useThemedStyles(hitStylesSheet)
  const t = useMobileTranslation()
  const { item, onOpen } = props
  const parts = searchMatchLineParts(item)
  return (
    <Pressable
      style={({ pressed }) => [styles.row, hitStyles.hit, pressed && styles.rowPressed]}
      onPress={() => onOpen(item.relativePath, item.name, { line: item.line, column: item.column })}
      accessibilityRole="button"
      accessibilityLabel={t('files.fileExplorerRow.openAtLine', 'Open {{name}} at line {{line}}', {
        name: item.name,
        line: item.line
      })}
    >
      <Text style={hitStyles.lineNumber}>{item.line}</Text>
      <Text style={hitStyles.text} numberOfLines={1}>
        {parts.before}
        <Text style={hitStyles.match}>{parts.match}</Text>
        {parts.after}
      </Text>
    </Pressable>
  )
}

const hitStylesSheet = themedStyleSheet((colors) => ({
  // Lined up with the file name above it: the result row's inset, icon slot and gap.
  hit: { minHeight: 44, paddingLeft: spacing.lg + 24 + spacing.xs + spacing.sm },
  lineNumber: {
    minWidth: 28,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  text: {
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  match: { color: colors.textPrimary, fontWeight: '700' }
}))
