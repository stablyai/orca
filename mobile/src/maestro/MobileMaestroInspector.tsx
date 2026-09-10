import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ExternalLink, Link2, X } from 'lucide-react-native'
import type {
  WorkspaceSuggestedLink,
  WorkspaceSurface
} from '../../../src/shared/maestro-workspace-canvas'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export function MobileMaestroInspector({
  surface,
  wide,
  linking,
  onClose,
  onOpen,
  onLink,
  suggestion,
  onAcceptSuggestion,
  onHideSuggestion
}: {
  surface: WorkspaceSurface
  wide: boolean
  linking: boolean
  onClose: () => void
  onOpen: () => void
  onLink: () => void
  suggestion?: WorkspaceSuggestedLink
  onAcceptSuggestion?: () => void
  onHideSuggestion?: () => void
}) {
  return (
    <View style={[styles.inspector, wide ? styles.wide : styles.phone]} testID="maestro-inspector">
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.eyebrow}>Selected surface</Text>
          <Text style={styles.title} numberOfLines={1}>
            {surface.title}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Close inspector"
          hitSlop={8}
          onPress={onClose}
          style={styles.iconButton}
        >
          <X size={17} color={colors.textSecondary} />
        </Pressable>
      </View>
      <Text style={styles.identity} numberOfLines={2}>
        {surface.id.unified_tab_id}
      </Text>
      <Text style={styles.detail}>
        {surface.availability} · {surface.content_type} · revision {surface.revision}
      </Text>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={onOpen} style={styles.primaryAction}>
          <ExternalLink size={16} color={colors.bgBase} />
          <Text style={styles.primaryText}>Open exact tab</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onLink}
          style={[styles.secondaryAction, linking && styles.secondaryActive]}
        >
          <Link2 size={16} color={colors.textPrimary} />
          <Text style={styles.secondaryText}>{linking ? 'Choose target' : 'Link surface'}</Text>
        </Pressable>
      </View>
      {suggestion ? (
        <View style={styles.suggestion}>
          <Text style={styles.eyebrow}>Suggested link</Text>
          <Text style={styles.detail} numberOfLines={2}>
            {suggestion.reason}
          </Text>
          <View style={styles.suggestionActions}>
            <Pressable onPress={onAcceptSuggestion} style={styles.suggestionButton}>
              <Text style={styles.secondaryText}>Accept</Text>
            </Pressable>
            <Pressable onPress={onHideSuggestion} style={styles.suggestionButton}>
              <Text style={styles.secondaryText}>Hide</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  inspector: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    padding: spacing.md,
    zIndex: 40,
    elevation: 12
  },
  wide: { top: 66, right: spacing.md, bottom: spacing.md, width: 272, borderRadius: radii.card },
  phone: {
    left: spacing.sm,
    right: spacing.sm,
    bottom: spacing.sm,
    minHeight: 210,
    borderRadius: radii.card
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  titleBlock: { flex: 1 },
  eyebrow: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.7
  },
  title: {
    marginTop: spacing.xs,
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '700'
  },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  identity: {
    marginTop: spacing.md,
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: typography.monoFamily
  },
  detail: { marginTop: spacing.sm, color: colors.textSecondary, fontSize: typography.metaSize },
  actions: { marginTop: spacing.lg, gap: spacing.sm },
  primaryAction: {
    minHeight: 44,
    borderRadius: radii.button,
    backgroundColor: colors.surfaceBright,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm
  },
  primaryText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '700' },
  secondaryAction: {
    minHeight: 44,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm
  },
  secondaryActive: { borderColor: colors.statusAmber },
  secondaryText: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  suggestion: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  suggestionActions: { marginTop: spacing.sm, flexDirection: 'row', gap: spacing.sm },
  suggestionButton: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
