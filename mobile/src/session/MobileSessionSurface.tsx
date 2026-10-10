import { View } from 'react-native'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionContentRow } from './MobileSessionContentRow'
import { MobileSessionHeader } from './MobileSessionHeader'
import { MobileSessionSheets } from './MobileSessionSheets'

export function MobileSessionSurface({ controller }: { controller: MobileSessionController }) {
  const { setMobileSessionRootRef } = controller
  return (
    <View ref={setMobileSessionRootRef} style={styles.container}>
      <View style={styles.kavInner}>
        <MobileSessionHeader controller={controller} />
        {/* Content-row host (KTD2): on wide, content shares this row with the docked panel as the flex-1 left child. */}
        <MobileSessionContentRow controller={controller} />
      </View>
      <MobileSessionSheets controller={controller} />
    </View>
  )
}
