import { useLocalSearchParams } from 'expo-router'
import { useHostClient } from '../../../../src/transport/client-context'
import { useMobilePrBranchContext } from '../../../../src/session/use-mobile-pr-branch-context'
import { MobilePrViewPanel } from '../../../../src/components/pr-sidebar/MobilePrViewPanel'

// Narrow-layout full-screen PR route. The standalone panel can't ride on the review
// screen's diff state, so branch/head SHA are resolved here from git.status + branchCompare.
export default function MobilePrViewScreen() {
  const { hostId, worktreeId } = useLocalSearchParams<{ hostId: string; worktreeId: string }>()
  const { client, state: connState } = useHostClient(hostId)
  const { branch, headSha, isGithubRepo, repoLoaded, loaded } = useMobilePrBranchContext({
    client,
    connState,
    worktreeId
  })

  return (
    <MobilePrViewPanel
      client={client}
      connState={connState}
      worktreeId={worktreeId}
      branch={branch}
      headSha={headSha}
      isGithubRepo={isGithubRepo}
      branchContextLoaded={loaded && repoLoaded}
      embedded={false}
    />
  )
}
