import { readWslHostDeployments } from '../../shared/wsl-host-deployment-store'
import {
  wslHostsPolicyMovedProjects,
  wslHostsPolicyState,
  type WslHostsPolicy
} from '../../shared/wsl-hosts-policy'
import { listWslMoveCutovers } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import { configureWslHostsGate } from './wsl-host-gate'
import { readCachedWslHostsPolicy } from './wsl-hosts-policy-live-update'

/** Reads the policy only with the internal gate open, and saved work only once it is closed. */
export function configureWslHostsGateFromDisk(userDataPath: string, appVersion: string): void {
  // One read serves both facts, so they can't disagree about a cache rewritten in between.
  let cached: { policy: WslHostsPolicy | null } | null = null
  const readPolicy = (): WslHostsPolicy | null =>
    (cached ??= { policy: readCachedWslHostsPolicy(userDataPath, appVersion) }).policy
  configureWslHostsGate({
    hasSavedWslHost: () => readWslHostDeployments(userDataPath).deployments.length > 0,
    // Any journal entry, committed or not: recovery must reset an in-flight move whose host is gone.
    hasWslMoveCutover: () => listWslMoveCutovers(userDataPath).length > 0,
    policy: () => wslHostsPolicyState(readPolicy()),
    movedProjects: () => wslHostsPolicyMovedProjects(readPolicy())
  })
}
