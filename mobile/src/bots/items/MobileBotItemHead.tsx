// The item page's title and description, on the same text edge as the cards below them. The item's
// number sits in the bar above ("#528"), so the title reads as plain words.
import { Text, View } from 'react-native'
import { LIST_ROW_PADDING } from '../../components/list/ListGroup'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { MobileBotItemDescription } from './MobileBotItemDescription'

export function MobileBotItemHead({
  title,
  description
}: {
  title: string
  description: string | null
}) {
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={styles.head}>
      <Text style={styles.title}>{title}</Text>
      {description ? <MobileBotItemDescription text={description} /> : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  // The cards' own side padding, so the title starts where their rows' text does.
  head: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingTop: spacing.xxs,
    paddingBottom: 6
  },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600', color: colors.textPrimary }
}))
