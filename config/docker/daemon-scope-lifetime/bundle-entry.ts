import { startDaemonScopeDeathWatch } from '../../../src/main/daemon/daemon-scope-death-watch'

export { buildDurableDaemonScopeCommand } from '../../../src/main/daemon/daemon-cgroup-scope'

export function startScopeReaper(launchNonce: string, freshScope: boolean) {
  return startDaemonScopeDeathWatch({ freshScope, launchNonce, log: () => {} })
}
