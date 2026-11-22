// An item's status glyph, as the desktop draws it: Planned a dashed ring, In progress a spinner while a linked
// worker runs (a ring otherwise), Needs you an orange dot (grey once stale), Done a check, Canceled a slashed circle.
import { View } from 'react-native'
import { CircleCheck, CircleSlash } from 'lucide-react-native'
import type { BotItemStatus } from '../../../../src/shared/bots/bot-items'
import { LoadingSpinner } from '../../components/feedback/LoadingSpinner'
import { colors, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export function MobileBotItemStatusIcon({
  status,
  live = false,
  stale = false,
  size = 10
}: {
  status: BotItemStatus
  live?: boolean
  stale?: boolean
  size?: number
}): React.JSX.Element {
  useMobileColorScheme()
  const box = { width: size, height: size }
  switch (status) {
    case 'needs_you':
      return <View style={[styles.dot, box, stale ? styles.needStale : styles.need]} />
    case 'working':
      return live ? (
        <LoadingSpinner size={size} color={colors.statusAmber} />
      ) : (
        <View style={[styles.dot, box, styles.ring]} />
      )
    case 'planned':
      return <View style={[styles.dot, box, styles.planned]} />
    case 'done':
      return <CircleCheck size={size} strokeWidth={2} color={colors.statusGreen} />
    case 'canceled':
      return <CircleSlash size={size} strokeWidth={2} color={colors.textMuted} />
  }
}

const styles = themedStyleSheet(() => ({
  dot: { borderRadius: radii.pill, flexShrink: 0 },
  need: { backgroundColor: colors.agentQuestion },
  needStale: { backgroundColor: colors.textMuted, opacity: 0.6 },
  ring: { borderWidth: 2, borderColor: colors.statusAmber },
  planned: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.textMuted }
}))
