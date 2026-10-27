import { ownFreshDaemonScope } from '../../../src/main/daemon/daemon-cgroup-scope'
import { startDaemonScopeDeathWatch } from '../../../src/main/daemon/daemon-scope-death-watch'
import { initializeTerminalScopes } from '../../../src/main/daemon/terminal-scopes-runtime'

export { buildDurableDaemonScopeCommand } from '../../../src/main/daemon/daemon-cgroup-scope'
export { wrapPtySpawnInTerminalScope } from '../../../src/main/daemon/terminal-scopes-runtime'

export function startScopeReaper(launchNonce: string, freshScope: boolean) {
  return startDaemonScopeDeathWatch({
    daemonScope: ownFreshDaemonScope(freshScope, launchNonce),
    log: () => {}
  })
}

/** What daemon-entry does at start: terminal scopes, then the death watch. */
export function startTerminalScopes(launchNonce: string) {
  const daemonScope = ownFreshDaemonScope(true, launchNonce)
  const events: unknown[] = []
  const ceiling = initializeTerminalScopes(daemonScope, (event, details) =>
    events.push({ event, ...details })
  )
  startDaemonScopeDeathWatch({ daemonScope, log: () => {} })
  return { ceiling, events }
}
