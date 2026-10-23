import type { ReactNode } from 'react'
import { View } from 'react-native'
import { ListGroup } from '../ui/ListGroup'
import { SectionHeader } from '../ui/SectionHeader'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  // Optional: omit for self-explanatory sections (e.g. action buttons).
  title?: string
  count?: number
  // A compact action at the header's end, e.g. "Add" reviewers or "Rerun failed".
  trailing?: ReactNode
  /**
   * `rows`: an inset group whose children are rows with hairlines between them.
   * `padded`: an inset group holding free content. `bare`: no group, e.g. a list of threads.
   */
  layout?: 'rows' | 'padded' | 'bare'
  children: ReactNode
  /** Drawn under the group, e.g. an agent launch notice. */
  footer?: ReactNode
}

/** One PR tab section: a sentence-case header over an inset group. */
export function PRSection({ title, count, trailing, layout = 'padded', children, footer }: Props) {
  return (
    <View style={styles.section}>
      {title ? <SectionHeader title={title} count={count} action={trailing} /> : null}
      {layout === 'rows' ? (
        <ListGroup>{children}</ListGroup>
      ) : layout === 'bare' ? (
        <View style={styles.bare}>{children}</View>
      ) : (
        <View style={[styles.group, styles.groupPadded]}>{children}</View>
      )}
      {footer ? <View style={styles.sectionFooter}>{footer}</View> : null}
    </View>
  )
}
