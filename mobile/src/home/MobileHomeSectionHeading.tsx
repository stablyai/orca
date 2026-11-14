import type { LucideIcon } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { homeListStyles as styles } from './home-list-styles'

const ASIDE_HIT_SLOP = { top: 10, bottom: 10, left: 12, right: 12 } as const

/** A Home section's title, with an optional muted note on the right; the first section sits closer to the bar. */
export function MobileHomeSectionHeading(props: {
  title: string
  first: boolean
  /** Shown muted after the title. */
  count?: number
  aside?: string
  asideIcon?: LucideIcon
  /** Turns the aside into a link. */
  onAsidePress?: () => void
}) {
  useMobileColorScheme()
  const AsideIcon = props.asideIcon
  return (
    <View style={[styles.sectionHeadingRow, props.first && styles.firstSectionHeading]}>
      <Text style={styles.sectionHeading} accessibilityRole="header" numberOfLines={1}>
        {props.title}
        {props.count !== undefined ? (
          <Text style={styles.sectionCount}>{`  ${props.count}`}</Text>
        ) : null}
      </Text>
      {props.aside && props.onAsidePress ? (
        <Pressable accessibilityRole="link" hitSlop={ASIDE_HIT_SLOP} onPress={props.onAsidePress}>
          {({ pressed }) => (
            <Text style={[styles.sectionAside, styles.sectionLink, pressed && styles.linkPressed]}>
              {props.aside}
            </Text>
          )}
        </Pressable>
      ) : props.aside ? (
        <View style={styles.sectionAsideRow}>
          {AsideIcon ? <AsideIcon size={13} color={colors.textMuted} /> : null}
          <Text style={styles.sectionAside} numberOfLines={1}>
            {props.aside}
          </Text>
        </View>
      ) : null}
    </View>
  )
}
