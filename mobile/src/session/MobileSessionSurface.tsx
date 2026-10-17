import { View } from 'react-native'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionContentRow } from './MobileSessionContentRow'
import { MobileSessionHeader } from './MobileSessionHeader'
import { MobileSessionSheets } from './MobileSessionSheets'
import { useWorkspaceSwitcher } from './use-workspace-switcher'
import { WorkspaceSwitcherSheet } from './WorkspaceSwitcherSheet'

export function MobileSessionSurface({ controller }: { controller: MobileSessionController }) {
  const { setMobileSessionRootRef, hostId, worktreeId, worktreeName, getDirtyMarkdownDrafts } =
    controller
  const switcher = useWorkspaceSwitcher({
    hostId,
    worktreeId,
    worktreeName,
    hasDirtyDrafts: () => getDirtyMarkdownDrafts().length > 0,
    showToast: controller.showToast
  })
  return (
    <View ref={setMobileSessionRootRef} style={styles.container}>
      <View style={styles.kavInner}>
        <MobileSessionHeader controller={controller} switcher={switcher} />
        {/* Content-row host (KTD2): on wide, content shares this row with the docked panel as the flex-1 left child. */}
        <MobileSessionContentRow controller={controller} />
      </View>
      <MobileSessionSheets controller={controller} />
      <WorkspaceSwitcherSheet
        switcher={switcher}
        currentHostId={hostId}
        currentWorktreeId={worktreeId}
      />
    </View>
  )
}
