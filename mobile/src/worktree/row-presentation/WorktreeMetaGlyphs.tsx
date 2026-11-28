import { CalendarClock, CircleDot, GitMerge, SquareTerminal, StickyNote } from 'lucide-react-native'
import { Text, View } from 'react-native'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { MobilePalette } from '../../theme/mobile-theme'
import { TaskProviderLogo } from '../../components/icons/TaskProviderLogo'
import type { WorktreeMetaGlyphPresence } from './worktree-meta-glyph-presence'
import { prStateToken } from '../../source-control/review/status/pr-state-token'
import { statusColor } from '../../source-control/review/status/pr-sidebar-status-color'

// Use shared prStateToken to match sidebar badge: merged purple, open green, closed red, draft/unknown muted.
export function prStateColor(state: string, colors: MobilePalette): string {
  return statusColor(prStateToken(state), colors)
}

// Match desktop metadata order; mobile glyphs show presence, with full details reserved for sheet.
export function WorktreeMetaGlyphs({ presence }: { presence: WorktreeMetaGlyphPresence }) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  if (!Object.values(presence).some(Boolean)) {
    return null
  }
  return (
    <View style={styles.metaGlyphs}>
      {presence.notes && <StickyNote size={11} color={colors.textMuted} />}
      {presence.automation && <CalendarClock size={11} color={colors.textMuted} />}
      {presence.cli && <SquareTerminal size={11} color={colors.textMuted} />}
      {presence.issue && <CircleDot size={11} color={colors.textMuted} />}
      {presence.jira && <TaskProviderLogo provider="jira" size={10} color={colors.textMuted} />}
      {presence.linear && <Text style={styles.linearGlyph}>L</Text>}
      {presence.gitLabMR && <GitMerge size={11} color={colors.textMuted} />}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  metaGlyphs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginLeft: 2
  },
  linearGlyph: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted
  }
}))
