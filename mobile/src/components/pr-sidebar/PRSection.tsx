import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  // Omit header for self-explanatory action sections to save mobile space.
  title?: string
  // Right-align optional header controls opposite title.
  trailing?: ReactNode
  children: ReactNode
}

// Use consistent desktop-style section/header divider; omit header only when title and trailing controls both absent.
export function PRSection({ title, trailing, children }: Props) {
  const showHeader = Boolean(title) || trailing != null
  return (
    <View style={styles.section}>
      {showHeader ? (
        <View style={styles.sectionHeader}>
          {title ? <Text style={styles.sectionLabel}>{title}</Text> : null}
          {trailing ? <View style={styles.sectionHeaderTrailing}>{trailing}</View> : null}
        </View>
      ) : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  )
}
