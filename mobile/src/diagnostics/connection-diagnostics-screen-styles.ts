import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { listStyleMetrics as metrics } from '../components/list/list-style-metrics'

export const connectionDiagnosticsScreenStyles = themedStyleSheet(() => ({
  content: { flex: 1 },
  hostPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md
  },
  hostChip: {
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  },
  hostChipActive: {
    backgroundColor: colors.groupedSurface,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  hostChipText: { fontSize: typography.metaSize, color: colors.textSecondary, maxWidth: 160 },
  hostChipTextActive: { color: colors.textPrimary, fontWeight: '600' },
  group: { marginBottom: spacing.lg },
  log: {
    backgroundColor: colors.groupedSurface,
    borderWidth: 0,
    borderRadius: metrics.groupRadius
  },
  emptyText: { fontSize: typography.metaSize, color: colors.textMuted, lineHeight: 18 }
}))
