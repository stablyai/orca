import { ChevronRight, Terminal } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import type { HomeResumeCard } from '../worktree/home-resume-card'

const REPO_COLORS = ['#8b5cf6', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4']

function homeResumeRepoColor(name: string): string {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0
  }
  return REPO_COLORS[Math.abs(hash) % REPO_COLORS.length]
}

export function MobileHomeResumeCard(props: {
  card: HomeResumeCard
  onOpen: (card: HomeResumeCard) => void
}) {
  return (
    <Pressable
      disabled={!props.card.actionable}
      style={({ pressed }) => [
        styles.resumeCard,
        !props.card.actionable && styles.cardDisabled,
        pressed && styles.cardPressed
      ]}
      onPress={() => props.onOpen(props.card)}
    >
      <View style={styles.resumeIcon}>
        <Terminal size={18} color={colors.textSecondary} />
      </View>
      <View style={styles.resumeMain}>
        <Text style={styles.resumeTitle} numberOfLines={1}>
          {props.card.worktree.displayName}
        </Text>
        <View style={styles.resumeSub}>
          <View
            style={[
              styles.repoDot,
              { backgroundColor: homeResumeRepoColor(props.card.worktree.repo) }
            ]}
          />
          <Text style={styles.resumeSubText} numberOfLines={1}>
            {props.card.worktree.repo}
            {'  ·  '}
            {props.card.worktree.branch}
          </Text>
        </View>
      </View>
      <ChevronRight size={16} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  resumeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: 12
  },
  cardDisabled: { opacity: 0.45 },
  cardPressed: { backgroundColor: colors.bgRaised },
  resumeIcon: {
    width: 46,
    height: 46,
    borderRadius: 13,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14
  },
  resumeMain: { flex: 1, minWidth: 0 },
  resumeTitle: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  resumeSub: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  repoDot: { width: 7, height: 7, borderRadius: 3.5 },
  resumeSubText: { fontSize: 12, color: colors.textSecondary, flex: 1 }
})
