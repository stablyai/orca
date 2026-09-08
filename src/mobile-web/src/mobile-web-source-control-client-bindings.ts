import type { MobileWebCommitMessageRequestClient } from './mobile-web-commit-message-request-client'
import type { MobileWebSourceControlRequestClient } from './mobile-web-source-control-request-client'
import type { MobileWebSourceControlSyncRequestClient } from './mobile-web-source-control-sync-request-client'

export function mobileWebSourceControlClientBindings(
  client: MobileWebSourceControlRequestClient,
  syncClient: MobileWebSourceControlSyncRequestClient,
  commitMessageClient: MobileWebCommitMessageRequestClient
) {
  return {
    sourceControlStatus: client.status.bind(client),
    sourceControlDiff: client.diff.bind(client),
    sourceControlBranches: client.branches.bind(client),
    sourceControlHistory: client.history.bind(client),
    sourceControlBranchCompare: client.branchCompare.bind(client),
    sourceControlCommitCompare: client.commitCompare.bind(client),
    sourceControlStage: client.stage.bind(client),
    sourceControlUnstage: client.unstage.bind(client),
    sourceControlDiscard: client.discard.bind(client),
    sourceControlCommit: client.commit.bind(client),
    sourceControlGenerateCommitMessage: commitMessageClient.generate.bind(commitMessageClient),
    sourceControlCancelCommitMessageGeneration:
      commitMessageClient.cancel.bind(commitMessageClient),
    sourceControlRepositoryState: syncClient.repositoryState.bind(syncClient),
    sourceControlCheckout: syncClient.checkout.bind(syncClient),
    sourceControlFetch: syncClient.fetch.bind(syncClient),
    sourceControlPull: syncClient.pull.bind(syncClient),
    sourceControlPush: syncClient.push.bind(syncClient),
    sourceControlRebase: syncClient.rebase.bind(syncClient),
    sourceControlAbort: syncClient.abort.bind(syncClient)
  }
}
