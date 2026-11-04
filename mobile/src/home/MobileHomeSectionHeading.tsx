import { Text, View } from 'react-native'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { homeListStyles as styles } from './home-list-styles'

/** A Home section's title, with an optional muted note on the right; the first section sits closer to the bar. */
export function MobileHomeSectionHeading(props: { title: string; first: boolean; aside?: string }) {
  useMobileColorScheme()
  return (
    <View style={[styles.sectionHeadingRow, props.first && styles.firstSectionHeading]}>
      <Text style={styles.sectionHeading} accessibilityRole="header">
        {props.title}
      </Text>
      {props.aside ? <Text style={styles.sectionAside}>{props.aside}</Text> : null}
    </View>
  )
}
