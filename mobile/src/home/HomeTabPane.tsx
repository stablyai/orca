import { memo, type ReactNode } from 'react'
import { View } from 'react-native'
import { WorkingMotionPaused } from '../components/motion/working-motion-pause'
import { themedStyleSheet } from '../theme/themed-styles'

type HomeTabPaneProps = {
  shown: boolean
  /** Another screen sits over Home. */
  covered: boolean
  children: ReactNode
}

/** A visited Home tab. Hidden, it keeps its last render and its working loops stop until it shows again. */
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
  // Home's data changes would otherwise rebuild every visited tab's list while nobody sees it.
  (previous, next) => !previous.shown && !next.shown
)

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  hidden: { display: 'none' }
}))
