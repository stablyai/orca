// The comment box's field and controls, as chat's composer lays them out: idle, one line between + and
// Send; in use, the field takes the box's full width above them, so a quote reads at full width. One tree
// either way, so focus and a held mic survive the change.
import { useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  COMPOSER_COMPACT_CONTROL_SIZE,
  MESSAGE_MIN_HEIGHT
} from '../../components/composer-input/composer-input-styles'
import { spacing } from '../../theme/mobile-theme'

export function MobileBotItemCommentBoxRow({
  open,
  field,
  lead,
  trail
}: {
  /** Focused, holding words or photos, or dictating. */
  open: boolean
  field: ReactNode
  /** The attach button, if the comment takes photos. */
  lead: ReactNode | null
  /** The mic, if any, and Send. */
  trail: ReactNode
}): React.JSX.Element {
  // The controls' widths either side of the one-line field.
  const [leadWidth, setLeadWidth] = useState(0)
  const [trailWidth, setTrailWidth] = useState(0)
  return (
    <View>
      <View
        style={
          open
            ? styles.field
            : [styles.field, styles.lineField, { left: leadWidth, right: trailWidth }]
        }
      >
        {field}
      </View>
      {/* Its open middle passes taps to the one-line field above it. */}
      <View style={[styles.actions, open && styles.actionsBelow]} pointerEvents="box-none">
        <View
          style={lead ? styles.lead : null}
          onLayout={(event) => setLeadWidth(event.nativeEvent.layout.width)}
        >
          {lead}
        </View>
        <View
          style={styles.trail}
          onLayout={(event) => setTrailWidth(event.nativeEvent.layout.width)}
        >
          {trail}
        </View>
      </View>
    </View>
  )
}

/** The compact send button's height, so a larger round control sits level with it and the line. */
export function MobileBotItemCommentBoxSlot({ children }: { children: ReactNode }) {
  return <View style={styles.slot}>{children}</View>
}

const styles = StyleSheet.create({
  field: { width: '100%' },
  // Over the action row, whose controls sit either side of it.
  lineField: { position: 'absolute', top: 0, width: 'auto', zIndex: 1 },
  actions: {
    minHeight: MESSAGE_MIN_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  actionsBelow: { marginTop: spacing.sm },
  lead: { paddingRight: spacing.sm },
  slot: { height: COMPOSER_COMPACT_CONTROL_SIZE, justifyContent: 'center' },
  trail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.sm
  }
})
