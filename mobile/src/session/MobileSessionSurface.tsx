import { View } from 'react-native'
import { styles } from './mobile-session-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionContentRow } from './MobileSessionContentRow'
import { MobileSessionHeader } from './MobileSessionHeader'
import { MobileSessionSheets } from './MobileSessionSheets'
import { useSessionSideRail } from './session-side-rail'

export function MobileSessionSurface({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const { setMobileSessionRootRef } = controller
  const rail = useSessionSideRail(controller)
  return (
    <View ref={setMobileSessionRootRef} style={styles.container}>
      <View style={styles.kavInner}>
        <MobileSessionHeader controller={controller} backInRail={rail.backInRail} />
        {}
        <MobileSessionContentRow controller={controller} keysInRail={rail.keysInRail} />
      </View>
      <MobileSessionSheets controller={controller} />
    </View>
  )
}
