import { radii } from '../../theme/mobile-theme'
import type { ListStyleMetrics } from './list-style-metrics'

// Material 3 ListItem: 56/72 dp rows, 16 dp insets and gaps, bodyLarge over bodyMedium, titleSmall headers in primary.
export const listStyleMetrics: ListStyleMetrics = {
  rowPadding: 16,
  leadingSlot: 24,
  rowGap: 16,
  rowMinHeight: 56,
  rowTwoLineMinHeight: 72,
  rowPaddingVertical: 8,
  // The large shape, as Material 3 settings cards.
  groupRadius: radii.surface,
  separators: false,
  ripple: true,
  title: { fontSize: 16, lineHeight: 24, letterSpacing: 0.5 },
  titleWithSubtitleWeight: '400',
  subtitle: { fontSize: 14, lineHeight: 20, letterSpacing: 0.25 },
  value: { fontSize: 14, lineHeight: 20, letterSpacing: 0.25 },
  header: { fontSize: 14, lineHeight: 20, fontWeight: '500', letterSpacing: 0.1 },
  headerColor: 'accentBlue',
  headerPaddingTop: 24,
  headerPaddingBottom: 8
}
