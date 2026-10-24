import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'

export const MIN_ASK_BODY_HEIGHT = 44

export const styles = StyleSheet.create({
  card: {
    maxHeight: 380,
    flexShrink: 1,
    minHeight: 0,
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  tabs: {
    flexGrow: 0,
    flexShrink: 0,
    paddingTop: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  tabsContent: {
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
    alignItems: 'center'
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 36,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tabActive: {
    borderBottomColor: colors.statusGreen
  },
  tabText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  tabTextActive: {
    color: colors.textPrimary
  },
  scroll: {
    minHeight: 0,
    flexShrink: 1
  },
  body: {
    paddingHorizontal: spacing.md
  },
  questionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  questionText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    fontWeight: '600',
    marginVertical: spacing.sm
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.card,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    marginBottom: spacing.xs
  },
  optionSelected: {
    borderColor: colors.statusGreen
  },
  check: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  checkCircle: {
    borderRadius: 9
  },
  checkSquare: {
    borderRadius: 4
  },
  checkOn: {
    backgroundColor: colors.statusGreen,
    borderColor: colors.statusGreen
  },
  optionBody: {
    flex: 1,
    gap: 2
  },
  optionLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  optionDescription: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  input: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    color: colors.textPrimary,
    fontSize: TEXT_INPUT_FONT_SIZE,
    padding: spacing.sm,
    minHeight: MIN_ASK_BODY_HEIGHT,
    marginBottom: spacing.xs
  },
  footer: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  cancel: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  progress: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  next: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary
  },
  nextDisabled: {
    backgroundColor: colors.bgRaised
  },
  nextText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  nextTextDisabled: {
    color: colors.textMuted
  }
})
