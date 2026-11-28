// A bot row's preview with the words a search matched in bold.
import { Text } from 'react-native'
import {
  splitBotSearchText,
  type BotSearchRange
} from '../../../src/shared/bots/bot-sidebar-search'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export function BoldMatches({ text, ranges }: { text: string; ranges: readonly BotSearchRange[] }) {
  const parts = splitBotSearchText(text, ranges)
  const starts = parts.map((_, at) =>
    parts.slice(0, at).reduce((length, part) => length + part.text.length, 0)
  )
  return (
    <>
      {parts.map((part, at) =>
        part.marked ? (
          <Text key={starts[at]} style={styles.previewMatch}>
            {part.text}
          </Text>
        ) : (
          part.text
        )
      )}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  previewMatch: { fontWeight: '600', color: colors.textPrimary }
}))
