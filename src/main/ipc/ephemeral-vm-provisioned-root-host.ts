import {
  findExactRepoOwner,
  isCapturedRepoCurrent
} from './worktrees/listing/worktree-host-ownership'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { adoptProvisionedRootSshCheckout } from '../provisioned-root-ssh-adoption'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type { AdoptProvisionedRootArgs } from '../../shared/worktree/create-types'
import type { Store } from '../persistence'

export async function adoptEphemeralVmProvisionedRoot(
  store: Store,
  getUserDataPath: () => string,
  args: AdoptProvisionedRootArgs
) {
  const ownedRuntime = listEphemeralVmRuntimes(getUserDataPath()).find(
    (entry) => entry.id === args.runtimeId
  )
  if (!ownedRuntime?.sshTargetId) {
    throw new Error('The provisioned runtime has no owning SSH target.')
  }
  const executionHostId = toSshExecutionHostId(ownedRuntime.sshTargetId)
  const repo = findExactRepoOwner(store, args.repoId, executionHostId)
  if (!repo?.connectionId) {
    throw new Error('The provisioned checkout has no owning SSH target.')
  }
  if (args.automationProvenanceRequest) {
    throw new Error('Automated provisioned-root creation is not supported by this release patch.')
  }
  return adoptProvisionedRootSshCheckout({
    userDataPath: getUserDataPath(),
    store,
    repo,
    request: { ...args, executionHostId: toSshExecutionHostId(repo.connectionId) },
    isRepoCurrent: () => isCapturedRepoCurrent(store, repo, executionHostId)
  })
}
