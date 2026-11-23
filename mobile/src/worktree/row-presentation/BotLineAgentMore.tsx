import { Text } from 'react-native'
import { colors, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

/** A bot worker line's other agents as "+N" right after its title. Its own piece so the look can change alone. */
export function BotLineAgentMore({ others, needsYou }: { others: number; needsYou: boolean }) {
  return <Text style={[styles.more, needsYou && styles.needsYou]}>+{others}</Text>
}

const styles = themedStyleSheet(() => ({
  more: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  needsYou: { color: colors.statusAmber }
}))
