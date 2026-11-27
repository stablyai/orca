import { Text } from 'react-native'
import { typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'

/** A bot worker line's other agents as "+N" right after its title. Its own piece so the look can change alone. */
export function BotLineAgentMore({ others, needsYou }: { others: number; needsYou: boolean }) {
  const styles = useThemedStyles(stylesSheet)
  return <Text style={[styles.more, needsYou && styles.needsYou]}>+{others}</Text>
}

const stylesSheet = themedStyleSheet((colors) => ({
  more: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  needsYou: { color: colors.statusAmber }
}))
