import type { ListStyleMetrics } from './list-style-metrics'

// HIG inset grouped lists as iOS 26 Settings draws them: body rows of 44 pt, footnote headers in sentence case.
export const listStyleMetrics: ListStyleMetrics = {
  rowPadding: 16,
  leadingSlot: 24,
  rowGap: 12,
  rowMinHeight: 44,
  rowTwoLineMinHeight: 58,
  rowPaddingVertical: 8,
  // iOS 26's inset grouped cell corner.
  groupRadius: 26,
  separators: true,
  ripple: false,
  // body, subheadline, footnote
  title: { fontSize: 17, lineHeight: 22 },
  titleWithSubtitleWeight: '400',
  subtitle: { fontSize: 15, lineHeight: 20 },
  value: { fontSize: 17, lineHeight: 22 },
  header: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  headerColor: 'textSecondary',
  headerPaddingTop: 22,
  headerPaddingBottom: 7
}
