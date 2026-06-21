import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  title: string
  // Optional trailing control(s) in the header row (e.g. add-reviewer, checks
  // summary + rerun). Rendered right-aligned opposite the title.
  trailing?: ReactNode
  children: ReactNode
}

// Shared card shell for the titled PR sections (Actions/Reviewers/Checks). Mirrors
// the desktop PR page's card-with-header-divider so the sections read consistently.
export function PRSection({ title, trailing, children }: Props) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{title}</Text>
        {trailing ? <View style={styles.sectionHeaderTrailing}>{trailing}</View> : null}
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  )
}
