import { memo, type ReactNode } from 'react'
import { View } from 'react-native'
import { WorkingMotionPaused } from '../components/motion/working-motion-pause'
import { themedStyleSheet } from '../theme/themed-styles'

type HomeTabPaneProps = {
  shown: boolean
  /** Another screen sits over Home. */
  covered: boolean
  /** Keep the last render while hidden; only for a tab whose rows own no clocks or subscriptions. */
  freezeHidden: boolean
  children: ReactNode
}

/** A visited Home tab: hidden or covered, its working loops stop until it shows again. */
export const HomeTabPane = memo(
  function HomeTabPane({ shown, covered, children }: HomeTabPaneProps) {
    return (
      <View style={shown ? styles.fill : styles.hidden}>
        <WorkingMotionPaused.Provider value={!shown || covered}>
          {children}
        </WorkingMotionPaused.Provider>
      </View>
    )
  },
  // A frozen tab skips rebuilding its list on every Home data change while nobody sees it.
  (previous, next) => next.freezeHidden && !previous.shown && !next.shown
)

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  hidden: { display: 'none' }
}))
