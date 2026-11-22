import type { TextStyle } from 'react-native'
import { radii } from '../../theme/mobile-theme'
import type { MobilePalette } from '../../theme/mobile-palette-roles'

// Each platform resolves its own list-style-metrics file: iOS inset grouped, Material 3 lists, desktop on the web.

export type ListStyleMetrics = {
  /** Space before the row content and after its trailing accessory. */
  readonly rowPadding: number
  /** The leading icon's column. */
  readonly leadingSlot: number
  /** Between the leading icon, the text, and trailing items. */
  readonly rowGap: number
  readonly rowMinHeight: number
  readonly rowTwoLineMinHeight: number
  readonly rowPaddingVertical: number
  readonly groupRadius: number
  /** Hairlines between a group's rows. */
  readonly separators: boolean
  /** The pressed row ripples instead of filling. */
  readonly ripple: boolean
  readonly title: TextStyle
  /** The title of a row that also carries a subtitle. */
  readonly titleWithSubtitleWeight: TextStyle['fontWeight']
  readonly subtitle: TextStyle
  readonly value: TextStyle
  readonly header: TextStyle
  readonly headerColor: keyof MobilePalette
  readonly headerPaddingTop: number
  readonly headerPaddingBottom: number
}

export const listStyleMetrics: ListStyleMetrics = {
  rowPadding: 16,
  leadingSlot: 24,
  rowGap: 12,
  rowMinHeight: 48,
  rowTwoLineMinHeight: 60,
  rowPaddingVertical: 8,
  groupRadius: radii.surface,
  separators: true,
  ripple: false,
  title: { fontSize: 15 },
  titleWithSubtitleWeight: '500',
  subtitle: { fontSize: 13 },
  value: { fontSize: 15 },
  header: { fontSize: 13, fontWeight: '500' },
  headerColor: 'textSecondary',
  headerPaddingTop: 16,
  headerPaddingBottom: 6
}
