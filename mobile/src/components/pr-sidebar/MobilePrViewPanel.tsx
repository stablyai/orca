import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '../../theme/mobile-theme'
import type { ConnectionState } from '../../transport/types'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobileGitStatusResult } from '../../source-control/mobile-git-status'
import type { MobilePrSidebarController } from '../../session/use-mobile-pr-sidebar-controller'
import { MobilePRSidebar } from '../MobilePRSidebar'

type Props = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  branch: string | null
  headSha: string | null
  gitStatus: MobileGitStatusResult | null
  isGithubRepo?: boolean
  branchContextLoaded?: boolean
  controller: MobilePrSidebarController
}

// Chromeless PR sidebar body for the source-control hub's Pull Request segment.
// The hub owns the header, segmented control, load triggers, and the shared
// controller (one fetch feeds both the branch-card chip and this body).
export function MobilePrViewPanelBody({
  client,
  connState,
  worktreeId,
  branch,
  headSha,
  gitStatus,
  isGithubRepo = true,
  branchContextLoaded = true,
  controller
}: Props) {
  const insets = useSafeAreaInsets()

  const sidebarState = !branchContextLoaded
    ? ({ kind: 'loading' } as const)
    : !isGithubRepo
      ? ({
          kind: 'blocked',
          message: 'Hosted review panel unavailable for this provider.'
        } as const)
      : branch === null
        ? ({
            kind: 'error',
            message: 'Current branch unavailable.'
          } as const)
        : controller.prSidebarState

  return (
    <View style={styles.container}>
      <MobilePRSidebar
        state={sidebarState}
        onRetry={controller.retryPRSidebar}
        refetch={controller.refetchPRSidebar}
        client={client}
        connState={connState}
        worktreeId={worktreeId}
        gitBranch={branch}
        gitStatus={gitStatus}
        headSha={headSha}
        bottomInset={insets.bottom}
        // Hub header already hosts open-on-web while this segment is active.
        showOpenOnWeb={false}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  }
})
