// Why: tasks.tsx is a 15k-line screen; pulling the StyleSheet block
// out keeps the component readable and keeps us below oxlint's
// per-file max-lines threshold without disabling the rule.
import { Platform, StyleSheet } from 'react-native'

import { colors, radii, spacing, typography } from '../../../src/theme/mobile-theme'

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  statusBar: {
    minHeight: 38,
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center'
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs
  },
  titleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2
  },
  toolbarScroll: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  segmentButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs
  },
  segmentIconButton: {
    width: 32,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button
  },
  segmentCountPill: {
    minWidth: 32,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm
  },
  segmentRepoDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  segmentButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary
  },
  segmentSecondaryText: {
    fontSize: 12,
    color: colors.textSecondary
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    paddingVertical: 2
  },
  errorBanner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  errorText: {
    color: colors.statusRed,
    fontSize: 13
  },
  sourceErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  sourceErrorCopy: {
    flex: 1,
    minWidth: 0
  },
  sourceErrorText: {
    color: colors.statusAmber,
    fontSize: 13,
    fontWeight: '600'
  },
  sourceErrorSlug: {
    fontFamily: typography.monoFamily,
    color: colors.textPrimary
  },
  sourceErrorMessage: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: 12
  },
  sourceErrorRetry: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  sourceErrorRetryText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  sourceNoticeBanner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  sourceNoticeText: {
    color: colors.statusAmber,
    fontSize: 13
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  centeredHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
    maxWidth: 280,
    textAlign: 'center'
  },
  centerActionButton: {
    marginTop: spacing.md,
    minWidth: 160
  },
  list: {
    paddingTop: spacing.xs
  },
  repoSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    backgroundColor: colors.bgBase
  },
  repoSectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  repoSectionTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + 26,
    marginRight: spacing.lg
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2
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
    borderRadius: 4
  },
  pickerRepoDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5
  },
  subtitle: {
    flex: 1,
    fontSize: 11,
    color: colors.textSecondary
  },
  branchMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 3,
    minWidth: 0
  },
  branchMetaText: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 180,
    fontSize: 11,
    color: colors.textPrimary
  },
  branchMetaBase: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 10,
    color: colors.textMuted
  },
  prSignalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs + 1
  },
  prSignalChip: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2
  },
  prSignalSuccess: {
    borderColor: colors.statusGreen
  },
  prSignalWarning: {
    borderColor: colors.statusAmber
  },
  prSignalDanger: {
    borderColor: colors.statusRed
  },
  prSignalText: {
    fontSize: 10,
    color: colors.textSecondary,
    fontWeight: '600'
  },
  statusPill: {
    maxWidth: 112,
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  statusPillSelf: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
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
    borderRadius: 4
  },
  linearListTrailing: {
    alignItems: 'flex-end',
    gap: spacing.xs
  },
  taskRowTrailing: {
    alignItems: 'flex-end',
    gap: spacing.xs
  },
  statusText: {
    fontSize: 11,
    color: colors.textSecondary
  },
  statusTextFlex: {
    flex: 1,
    minWidth: 0
  },
  paginationFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm
  },
  paginationButton: {
    width: 44,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    paddingVertical: spacing.sm
  },
  paginationButtonDisabled: {
    opacity: 0.45
  },
  paginationLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: 'center'
  },
  paginationLabelButton: {
    flex: 1,
    alignItems: 'center',
    borderRadius: radii.button,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm
  },
  boardContainer: {
    gap: spacing.md,
    padding: spacing.md
  },
  boardColumn: {
    width: 280,
    maxHeight: '100%',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  boardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  boardTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  boardCount: {
    color: colors.textMuted,
    fontSize: 11
  },
  boardCard: {
    margin: spacing.sm,
    marginBottom: 0,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgBase,
    padding: spacing.md
  },
  repoPickerGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  pagePickerList: {
    maxHeight: 420,
    backgroundColor: colors.bgPanel,
    borderRadius: 12
  },
  projectPickerControls: {
    gap: spacing.sm,
    marginBottom: spacing.md
  },
  projectWarningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.statusAmber,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  projectWarningTextWrap: {
    flex: 1,
    minWidth: 0
  },
  projectWarningTitle: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  projectWarningText: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2
  },
  projectDataNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  projectDataNoticeText: {
    flex: 1,
    color: colors.statusAmber,
    fontSize: 13
  },
  projectGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel
  },
  projectGroupChevronCollapsed: {
    transform: [{ rotate: '-90deg' }]
  },
  projectGroupTitle: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  projectGroupMeta: {
    color: colors.textMuted,
    fontSize: 11
  },
  projectFieldPillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  projectFieldPill: {
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 999,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  projectFieldPillText: {
    color: colors.textSecondary,
    fontSize: 11
  },
  projectFieldPillEmptyText: {
    color: colors.textMuted
  },
  projectPasteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  projectPasteInput: {
    flex: 1
  },
  projectPasteButton: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  pickerRowSelected: {
    backgroundColor: colors.bgRaised
  },
  pickerRowContent: {
    flex: 1,
    minWidth: 0
  },
  pickerRowLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  pickerRowSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1
  },
  pickerRowWithAction: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  pickerRowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md
  },
  pickerCheck: {
    width: 18,
    alignItems: 'center'
  },
  pickerContent: {
    flex: 1,
    minWidth: 0
  },
  pickerLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  monoText: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  },
  pickerSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1
  },
  iconActionButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  groupSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  repoPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md
  },
  repoPickerTextWrap: {
    flex: 1,
    minWidth: 0
  },
  repoPickerTitle: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  repoPickerSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1
  },
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
  actionGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  detailGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
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
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  detailChipSelected: {
    borderColor: colors.accentBlue,
    backgroundColor: colors.bgRaised
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
    borderRadius: 999
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
  fieldButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  fieldButtonDisabled: {
    opacity: 0.55
  },
  fieldButtonPlaceholder: {
    color: colors.textMuted
  },
  fieldButtonText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  workspaceCreateForm: {
    gap: 0
  },
  workspaceCreateField: {
    marginBottom: spacing.md
  },
  workspaceCreateLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs
  },
  workspaceCreateLabelHint: {
    fontWeight: '400',
    color: colors.textMuted
  },
  workspaceAdvancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs
  },
  workspaceAdvancedText: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textSecondary
  },
  workspaceCreateActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.sm
  },
  workspaceCreateButton: {
    minWidth: 160,
    paddingHorizontal: spacing.lg
  },
  sshConnectCard: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs
  },
  sshStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sshStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 999
  },
  sshStatusDotConnected: {
    backgroundColor: colors.statusGreen
  },
  sshStatusDotProgress: {
    backgroundColor: colors.statusAmber
  },
  sshStatusDotDisconnected: {
    backgroundColor: colors.statusRed
  },
  sshStatusCopy: {
    flex: 1,
    minWidth: 0
  },
  sshStatusTitle: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  reviewerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  reviewerAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  reviewerAvatarText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary
  },
  reviewerInfo: {
    flex: 1,
    minWidth: 0
  },
  reviewerName: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary
  },
  reviewerMeta: {
    fontSize: 11,
    color: colors.textMuted
  },
  reviewerState: {
    flexShrink: 0,
    fontSize: 11,
    color: colors.textSecondary
  },
  projectFieldCard: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    padding: spacing.sm,
    gap: spacing.xs
  },
  projectFieldName: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary
  },
  projectFieldValue: {
    maxWidth: 140,
    fontSize: 12,
    color: colors.textMuted
  },
  projectIterationList: {
    gap: spacing.xs
  },
  projectIterationCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  detailLine: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary
  },
  fileActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 2
  },
  fileCard: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    padding: spacing.sm,
    gap: spacing.xs
  },
  pipelineStatusChip: {
    flexShrink: 0,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 999,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  pipelineStatusSuccess: {
    borderColor: colors.statusGreen
  },
  pipelineStatusWarning: {
    borderColor: colors.statusAmber
  },
  pipelineStatusDanger: {
    borderColor: colors.statusRed
  },
  pipelineStatusActive: {
    borderColor: colors.accentBlue
  },
  pipelineStatusText: {
    fontSize: 10,
    color: colors.textSecondary,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  filePreview: {
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  fileDiff: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    overflow: 'hidden'
  },
  diffLineBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    gap: spacing.xs
  },
  diffLineAdded: {
    borderLeftColor: colors.statusGreen
  },
  diffLineRemoved: {
    borderLeftColor: colors.statusRed
  },
  diffCodeRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'flex-start'
  },
  diffLineNumbers: {
    width: 76,
    flexShrink: 0,
    fontFamily: typography.monoFamily,
    fontSize: 10,
    lineHeight: 16,
    color: colors.textMuted
  },
  codeLine: {
    flex: 1,
    fontFamily: typography.monoFamily,
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary
  },
  diffCodeAdded: {
    color: colors.statusGreen
  },
  diffCodeRemoved: {
    color: colors.statusRed
  },
  detailMuted: {
    fontSize: 12,
    color: colors.textSecondary
  },
  commentBlock: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    paddingTop: spacing.sm
  },
  commentThreadGroup: {
    gap: spacing.xs
  },
  commentReplyBlock: {
    marginLeft: spacing.md,
    paddingLeft: spacing.sm,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  commentResolvedBlock: {
    opacity: 0.6
  },
  resolvedCommentSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm
  },
  resolvedCommentTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: colors.textSecondary
  },
  commentSource: {
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
    marginBottom: 2
  },
  commentMeta: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 2
  },
  commentControls: {
    gap: spacing.xs,
    marginTop: spacing.sm
  },
  reactionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  reactionChip: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  reactionText: {
    fontSize: 11,
    color: colors.textSecondary
  },
  inlineActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md
  },
  actionText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  actionSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  setupPromptBox: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs
  },
  setupPromptCommand: {
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textPrimary
  },
  linearStatesBlock: {
    paddingTop: spacing.sm
  },
  linearStatesTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing.md + 2,
    paddingBottom: spacing.xs
  },
  emptyInlineText: {
    color: colors.textSecondary,
    fontSize: 13,
    paddingHorizontal: spacing.md + 2,
    paddingBottom: spacing.md
  },
  createForm: {
    gap: spacing.sm
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary
  },
  inlineTextLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs
  },
  inlineTextLinkText: {
    color: colors.textSecondary,
    fontSize: 12,
    textDecorationLine: 'underline'
  },
  securityHintRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs
  },
  securityHintText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16
  },
  targetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2
  },
  targetButtonText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  issueSourceBox: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    padding: spacing.sm,
    gap: spacing.xs
  },
  issueSourceHint: {
    fontSize: 12,
    color: colors.textSecondary
  },
  issueSourceSegment: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    backgroundColor: colors.bgBase,
    padding: 2,
    gap: 2
  },
  issueSourceSegmentButton: {
    flex: 1,
    borderRadius: radii.input - 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  issueSourceSegmentButtonActive: {
    backgroundColor: colors.bgRaised
  },
  issueSourceSegmentText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted
  },
  issueSourceSegmentTextActive: {
    color: colors.textPrimary
  },
  issueSourceSlug: {
    marginTop: 1,
    fontSize: 10,
    color: colors.textMuted
  },
  drawerLoadingRow: {
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  input: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  bodyInput: {
    minHeight: 88
  },
  monoInput: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  },
  commentInput: {
    minHeight: 72,
    marginTop: spacing.sm
  },
  commentComposer: {
    position: 'relative',
    marginTop: spacing.sm
  },
  commentComposerInput: {
    minHeight: 40,
    maxHeight: 120,
    marginTop: 0,
    paddingRight: 44
  },
  commentComposerSend: {
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    width: 32,
    height: 32,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  commentComposerSendPressed: {
    opacity: 0.75
  },
  commentComposerSendDisabled: {
    opacity: 0.5
  },
  replyInput: {
    minHeight: 48,
    marginTop: spacing.xs
  },
  stackedInput: {
    marginTop: spacing.sm
  },
  inlineSaveButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  inlineSaveButtonCompact: {
    alignSelf: 'flex-start',
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  inlineSaveText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  inlineButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  drawerActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  secondaryActionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingVertical: spacing.sm
  },
  secondaryActionText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  primaryActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    paddingVertical: spacing.sm
  },
  primaryActionText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  inlineDeleteText: {
    color: colors.statusRed,
    fontSize: 12,
    fontWeight: '600'
  },
  createButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.textPrimary,
    borderRadius: radii.button,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center'
  },
  createButtonDisabled: {
    opacity: 0.5
  },
  createButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  }
})
