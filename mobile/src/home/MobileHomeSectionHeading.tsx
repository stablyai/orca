import { Text } from 'react-native'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { homeListStyles as styles } from './home-list-styles'

/** A Home section's title; the first section on screen sits closer to the top bar. */
export function MobileHomeSectionHeading(props: { title: string; first: boolean }) {
  useMobileColorScheme()
  return (
    <Text
      style={[styles.sectionHeading, props.first && styles.firstSectionHeading]}
      accessibilityRole="header"
    >
      {props.title}
    </Text>
  )
}
