import { CalendarClock, CircleDot, GitMerge, SquareTerminal, StickyNote } from 'lucide-react-native'
import { StyleSheet, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { TaskProviderLogo } from './TaskProviderLogo'
import type { WorktreeMetaGlyphPresence } from '../worktree/worktree-meta-glyph-presence'
import { prStateToken } from './pr-state-token'
import { statusColor } from './pr-sidebar/pr-sidebar-status-color'

// PR chip color by state, resolved through the shared prStateToken so it always
// matches the PR sidebar's state badge: merged = purple, open = green, closed =
// red, draft/unknown = muted.
export function prStateColor(state: string): string {
  return statusColor(prStateToken(state))
}

// Presence glyphs in the desktop WorktreeCardMetaBadges order. Mobile shows presence only; the
// full detail (title/state/labels) is a follow-up detail sheet.
export function WorktreeMetaGlyphs({ presence }: { presence: WorktreeMetaGlyphPresence }) {
  if (!Object.values(presence).some(Boolean)) {
    return null
  }
  return (
    <View style={styles.metaGlyphs}>
      {presence.notes && <StickyNote size={GLYPH} color={colors.textMuted} />}
      {presence.automation && <CalendarClock size={GLYPH} color={colors.textMuted} />}
      {presence.cli && <SquareTerminal size={GLYPH} color={colors.textMuted} />}
      {presence.issue && <CircleDot size={GLYPH} color={colors.textMuted} />}
      {presence.jira && <TaskProviderLogo provider="jira" size={GLYPH} color={colors.textMuted} />}
      {presence.linear && (
        <TaskProviderLogo provider="linear" size={GLYPH} color={colors.textMuted} />
      )}
      {presence.gitLabMR && <GitMerge size={GLYPH} color={colors.textMuted} />}
    </View>
  )
}

const GLYPH = 14

const styles = StyleSheet.create({
  metaGlyphs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0
  }
})
