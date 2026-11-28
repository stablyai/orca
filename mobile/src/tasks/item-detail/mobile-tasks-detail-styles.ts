import { themedStyleSheet } from '../../theme/themed-styles'
import { radii, spacing } from '../../theme/mobile-theme'
import {
  composerInputStylesSheet,
  COMPOSER_TEXT_SIZE
} from '../../components/composer-input/composer-input-styles'
import { LIST_ROW_PADDING } from '../../components/list/ListGroup'

export const mobileTasksDetailStylesSheet = themedStyleSheet((colors, scheme) => ({
  sheetHeader: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sheetTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
    lineHeight: 20
  },
  sheetSubtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2
  },
  // Lines prose up with the row text of the groups above it.
  itemSectionBody: {
    paddingHorizontal: LIST_ROW_PADDING,
    gap: spacing.sm
  },
  detailGroup: {
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.md
  },
  detailLoading: {
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  detailLoadingInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  detailError: {
    color: colors.statusRed,
    fontSize: 13
  },
  detailMetaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  },
  detailMetaItem: {
    minWidth: 96,
    flexGrow: 1
  },
  detailMetaLabel: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 2
  },
  detailMetaValue: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  detailChip: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.translucentFill,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  detailChipSelected: {
    borderColor: colors.accentBlue,
    backgroundColor: colors.translucentFill
  },
  detailChipText: {
    fontSize: 11,
    color: colors.textSecondary
  },
  issueTypeChipContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  issueTypeDot: {
    width: 7,
    height: 7,
    borderRadius: radii.pill
  },
  detailSection: {
    gap: spacing.xs
  },
  detailSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  detailSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  detailSectionMeta: {
    flexShrink: 0,
    fontSize: 11,
    color: colors.textMuted
  },
  // Pickers sit beside text fields in these forms, so they wear the same field shell.
  fieldButton: {
    ...composerInputStylesSheet.resolve(scheme).field,
    paddingVertical: spacing.sm
  },
  fieldButtonDisabled: {
    opacity: 0.55
  },
  fieldButtonPlaceholder: {
    color: colors.textMuted
  },
  fieldButtonText: {
    flex: 1,
    fontSize: COMPOSER_TEXT_SIZE,
    color: colors.textPrimary
  }
}))
