import { CalendarClock, CircleDot, GitMerge, SquareTerminal, StickyNote } from 'lucide-react-native'
import { StyleSheet, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { TaskProviderLogo } from './TaskProviderLogo'
import type { WorktreeMetaGlyphPresence } from '../worktree/worktree-meta-glyph-presence'
import { prStateToken } from './pr-state-token'
import { statusColor } from './pr-sidebar/pr-sidebar-status-color'

// Use shared prStateToken to match sidebar badge: merged purple, open green, closed red, draft/unknown muted.
export function prStateColor(state: string): string {
  return statusColor(prStateToken(state))
}

// Match desktop metadata order; mobile glyphs show presence, with full details reserved for sheet.
export function WorktreeMetaGlyphs({ presence }: { presence: WorktreeMetaGlyphPresence }) {
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

const styles = StyleSheet.create({
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
})
