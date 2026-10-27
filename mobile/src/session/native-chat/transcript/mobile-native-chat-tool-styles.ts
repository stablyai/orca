import { Platform, StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { MONO_SIZE, scaledType } from '../../mobile-native-chat-message-styles'

export function toolType(fontScale: number) {
  return {
    row: scaledType(typography.bodySize, fontScale),
    code: scaledType(MONO_SIZE, fontScale, 5),
    meta: scaledType(typography.metaSize, fontScale)
  }
}

// iOS has no font named `monospace`; it silently falls back to the proportional system face.
const MONO_FAMILY = Platform.OS === 'ios' ? 'Menlo' : typography.monoFamily

export const toolStyles = StyleSheet.create({
  run: {
    marginTop: spacing.xs
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 3
  },
  headerSentence: {
    flexShrink: 1,
    color: colors.textMuted
  },
  headerSentenceLive: {
    flexShrink: 0,
    maxWidth: '72%',
    color: colors.textPrimary
  },
  headerMarks: {
    flexShrink: 0
  },
  headerLatest: {
    flexShrink: 1,
    color: colors.textMuted
  },
  members: {
    marginLeft: 7,
    marginTop: 2,
    paddingLeft: 13,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 26
  },
  iconSlot: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  lineWord: {
    flexShrink: 0,
    color: colors.textMuted
  },
  lineName: {
    flexShrink: 0,
    maxWidth: '60%'
  },
  lineTarget: {
    flexShrink: 1,
    color: colors.textPrimary
  },
  lineLink: {
    textDecorationLine: 'underline'
  },
  lineTrailing: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: spacing.sm
  },
  lineMeta: {
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  caretOpen: {
    transform: [{ rotate: '90deg' }]
  },
  detail: {
    marginLeft: 24,
    paddingVertical: spacing.xs,
    gap: 6
  },
  codeBox: {
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    padding: spacing.sm
  },
  // Bound long output to a scroll box so it cannot fill the transcript.
  codeScroll: {
    maxHeight: 256,
    flexGrow: 0
  },
  codeText: {
    color: colors.textPrimary,
    fontFamily: MONO_FAMILY
  },
  searchResults: {
    gap: 2
  },
  searchHit: {
    textDecorationLine: 'underline'
  },
  searchUrl: {
    color: colors.textMuted,
    textDecorationLine: 'none'
  },
  taskCard: {
    gap: spacing.xs,
    paddingVertical: spacing.xs
  },
  taskHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  taskTitle: {
    fontWeight: '500'
  },
  taskList: {
    gap: spacing.xs,
    paddingVertical: spacing.xs
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6
  },
  taskIcon: {
    justifyContent: 'center'
  },
  taskText: {
    flexShrink: 1,
    color: colors.textMuted
  },
  taskActive: {
    color: colors.textPrimary,
    fontWeight: '500'
  },
  taskDisclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 2
  },
  errorText: {
    color: colors.statusRed
  },
  diffAdd: {
    color: colors.chatDiffAdded,
    backgroundColor: colors.diffAddedBg
  },
  diffDel: {
    color: colors.chatDiffRemoved,
    backgroundColor: colors.diffDeletedBg
  },
  diffMeta: {
    color: colors.textMuted
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginVertical: 2
  },
  cardToggle: {
    flex: 1,
    minWidth: 0
  },
  shrinkable: {
    flexShrink: 1
  },
  struck: {
    textDecorationLine: 'line-through'
  },
  countAdded: {
    color: colors.gitDecorationAdded
  },
  countRemoved: {
    color: colors.gitDecorationDeleted
  },
  diffBody: {
    marginLeft: 24,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
    maxHeight: 288,
    flexGrow: 0,
    paddingHorizontal: 0
  },
  diffRow: {
    flexDirection: 'row',
    alignItems: 'flex-start'
  },
  diffAddGround: {
    backgroundColor: colors.diffAddedBg
  },
  diffDelGround: {
    backgroundColor: colors.diffDeletedBg
  },
  diffGutter: {
    paddingRight: 6,
    textAlign: 'right',
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  diffAddGutter: {
    backgroundColor: colors.diffAddedGutter
  },
  diffDelGutter: {
    backgroundColor: colors.diffDeletedGutter
  },
  diffSign: {
    width: 14,
    textAlign: 'center'
  },
  diffAddText: {
    color: colors.chatDiffAdded
  },
  diffDelText: {
    color: colors.chatDiffRemoved
  },
  diffText: {
    flex: 1,
    paddingRight: spacing.sm
  },
  diffGap: {
    textAlign: 'center',
    color: colors.textMuted,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  }
})
