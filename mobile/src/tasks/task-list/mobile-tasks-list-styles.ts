import { themedStyleSheet } from '../../theme/themed-styles'
import { colors, radii, spacing } from '../../theme/mobile-theme'

export const mobileTasksListStyles = themedStyleSheet(() => ({
  taskRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  taskRowPressed: {
    backgroundColor: colors.bgRaised
  },
  taskIcon: {
    width: 20,
    paddingTop: 3,
    marginRight: spacing.sm,
    alignItems: 'center'
  },
  taskMain: {
    flex: 1,
    minWidth: 0,
    marginRight: spacing.sm
  },
  taskTitleRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start'
  },
  taskTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    lineHeight: 18
  },
  updatedAt: {
    fontSize: 11,
    color: colors.textMuted,
    paddingTop: 2
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: spacing.xs
  },
  repoDot: {
    width: 7,
    height: 7,
    borderRadius: radii.pill
  },
  pickerRepoDot: {
    width: 9,
    height: 9,
    borderRadius: radii.pill
  },
  subtitle: {
    flex: 1,
    fontSize: 11,
    color: colors.textSecondary
  },
  statusPill: {
    maxWidth: 112,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  statusPillSelf: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgRaised,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    marginTop: spacing.sm
  },
  linearStatePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  linearStateDot: {
    width: 7,
    height: 7,
    borderRadius: radii.pill
  },
  statusText: {
    fontSize: 11,
    color: colors.textSecondary
  },
  statusTextFlex: {
    flex: 1,
    minWidth: 0
  }
}))
