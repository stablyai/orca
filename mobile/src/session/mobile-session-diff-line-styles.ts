import { StyleSheet } from 'react-native'
import { colors, MIN_TOUCH_TARGET, radii, spacing, textStyles } from '../theme/mobile-theme'

// The session file reader's diff line: its add-note button, notes and inline note composer.
export const sessionDiffLineStyles = StyleSheet.create({
  addTouch: {
    width: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  addMarker: {
    width: 26,
    height: 20,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  addMarkerPressed: { backgroundColor: colors.fillPressed, transform: [{ scale: 0.92 }] },
  disabled: { opacity: 0.4 },
  notes: {
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.field,
    backgroundColor: colors.fill
  },
  noteIcon: { marginTop: 10 },
  noteMain: { flex: 1, minWidth: 0, paddingVertical: 6, gap: 2 },
  noteMeta: { ...textStyles.caption, color: colors.textMuted },
  noteBody: { ...textStyles.subhead, color: colors.textPrimary },
  composer: {
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  composerActions: { flexDirection: 'row', justifyContent: 'flex-end' }
})
