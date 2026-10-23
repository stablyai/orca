import { StyleSheet } from 'react-native'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { colors, motion, radii, spacing, textStyles, typography } from '../theme/mobile-theme'

export const mobileBrowserPaneStyles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.bgBase
  },
  toolbar: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
    backgroundColor: colors.bgBase,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator
  },
  // The 44 pt box overhangs the 40 pt field's right end.
  reload: { marginVertical: -2, marginLeft: -6 },
  viewport: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: colors.bgBase
  },
  browserImageHost: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  browserImageFill: {
    width: '100%',
    height: '100%'
  },
  browserImageLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center'
  },
  browserImageLayerHidden: {
    opacity: 0
  },
  browserZoomOffset: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  browserFrameBox: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  browserImage: {
    backgroundColor: colors.bgBase
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    // A faint veil over a stale frame while a new one loads; not a token, it dims the page itself.
    backgroundColor: 'rgba(13, 15, 24, 0.2)'
  },
  loading: { alignItems: 'center', gap: spacing.md },
  loadingText: { ...textStyles.callout, color: colors.textSecondary },
  errorCard: {
    maxWidth: 320,
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg + 4,
    borderRadius: radii.group,
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.fieldBorder
  },
  errorTitle: { ...textStyles.headline, color: colors.textPrimary, textAlign: 'center' },
  errorText: { ...textStyles.callout, color: colors.textSecondary, textAlign: 'center' },
  dialogOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 30,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: 'rgba(0, 0, 0, 0.5)'
  },
  dialogCard: {
    width: '100%',
    maxWidth: 340,
    gap: spacing.sm,
    borderRadius: radii.replyBox,
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.fieldBorder,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg
  },
  dialogTitle: { ...textStyles.headline, color: colors.textPrimary },
  dialogMessage: { ...textStyles.body, color: colors.textSecondary },
  dialogError: { ...textStyles.footnote, color: colors.danger },
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm
  },
  keyboardDock: {
    zIndex: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    backgroundColor: colors.bgBase
  },
  dockKeys: { paddingHorizontal: spacing.md, paddingTop: spacing.xs },
  dockKeysRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inputRow: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm
  },
  inputBox: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingLeft: spacing.xs,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: radii.replyBox,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.fieldFill
  },
  inputBoxFocused: { borderColor: colors.fieldBorderFocused },
  keyboardInput: {
    flex: 1,
    minWidth: 0,
    height: 32,
    color: colors.textPrimary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 0,
    // The seam: on the web an input under 16px zooms the page on focus and the keyboard seam reads
    // that zoom as "no keyboard".
    fontSize: TEXT_INPUT_FONT_SIZE,
    fontFamily: typography.monoFamily
  },
  typeTrigger: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    backgroundColor: colors.fill
  },
  typeTriggerPressed: { backgroundColor: colors.fillPressed },
  typeTriggerText: { ...textStyles.callout, color: colors.textSecondary, flex: 1 },
  typeTriggerHint: { ...textStyles.footnote, color: colors.textPrimary },
  disabled: { opacity: motion.disabledOpacity }
})
