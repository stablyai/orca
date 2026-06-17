import { CircleDot, GitMerge, StickyNote } from 'lucide-react-native'
import { StyleSheet, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'

// PR chip color by state, mirroring the desktop ReviewIcon palette: merged =
// purple, open = green, closed = red, draft/unknown = muted.
export function prStateColor(state: string): string {
  const s = state.toLowerCase()
  if (s === 'merged') {
    return '#a78bfa'
  }
  if (s === 'open') {
    return colors.statusGreen
  }
  if (s === 'closed') {
    return colors.statusRed
  }
  return colors.textSecondary
}

type Props = {
  comment?: string | null
  linkedLinearIssue?: string | null
  linkedGitLabMR?: number | null
  linkedIssue?: number | null
  linkedGitLabIssue?: number | null
}

// Presence glyphs for linked notes / Linear / GitLab MR / issue, matching the
// desktop WorktreeCardMetaBadges row. Mobile shows presence only; the full
// detail (title/state/labels) is a follow-up detail sheet.
export function WorktreeMetaGlyphs({
  comment,
  linkedLinearIssue,
  linkedGitLabMR,
  linkedIssue,
  linkedGitLabIssue
}: Props) {
  const hasNotes = (comment ?? '').trim().length > 0
  const hasLinear = Boolean(linkedLinearIssue)
  const hasGitLabMR = linkedGitLabMR != null
  const hasIssue = linkedIssue != null || linkedGitLabIssue != null
  if (!hasNotes && !hasLinear && !hasGitLabMR && !hasIssue) {
    return null
  }
  return (
    <View style={styles.metaGlyphs}>
      {hasNotes && <StickyNote size={11} color={colors.textMuted} />}
      {hasIssue && <CircleDot size={11} color={colors.textMuted} />}
      {hasLinear && <Text style={styles.linearGlyph}>L</Text>}
      {hasGitLabMR && <GitMerge size={11} color={colors.textMuted} />}
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
