import { readWslHostDeployments } from '../../shared/wsl-host-deployment-store'
import { listWslMoveCutovers } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import { configureWslHostsGate } from './wsl-host-gate'

/** Reads only with the internal gate closed: an open gate needs no promotion. */
export function configureWslHostsGateFromDisk(userDataPath: string): void {
  configureWslHostsGate({
    hasSavedWslHost: () => readWslHostDeployments(userDataPath).deployments.length > 0,
    // Any journal entry, committed or not: recovery must reset an in-flight move whose host is gone.
    hasWslMoveCutover: () => listWslMoveCutovers(userDataPath).length > 0
  })
}
