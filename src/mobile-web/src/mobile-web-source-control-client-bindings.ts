import type { MobileWebSourceControlRequestClient } from './mobile-web-source-control-request-client'
import type { MobileWebSourceControlSyncRequestClient } from './mobile-web-source-control-sync-request-client'

export function mobileWebSourceControlClientBindings(
  client: MobileWebSourceControlRequestClient,
  syncClient: MobileWebSourceControlSyncRequestClient
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
    sourceControlGenerateCommitMessage: client.generateCommitMessage.bind(client),
    sourceControlCancelCommitMessageGeneration: client.cancelCommitMessageGeneration.bind(client),
    sourceControlUpstream: syncClient.upstream.bind(syncClient),
    sourceControlCheckout: syncClient.checkout.bind(syncClient),
    sourceControlFetch: syncClient.fetch.bind(syncClient),
    sourceControlPull: syncClient.pull.bind(syncClient),
    sourceControlPush: syncClient.push.bind(syncClient),
    sourceControlRebase: syncClient.rebase.bind(syncClient),
    sourceControlAbort: syncClient.abort.bind(syncClient)
  }
}
