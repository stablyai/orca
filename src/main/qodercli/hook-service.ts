import { existsSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { ClaudeHookService } from '../claude/hook-service'
import { QODERCLI_CN_HOOK_SETTINGS, QODERCLI_HOOK_SETTINGS } from '../claude/hook-settings'

// Why: qodercli ships as two independently-built artifacts — the global build reads `~/.qoder`, the
// China build reads `~/.qoder-cn` — but Orca models them as one agent (one binary alias set, one
// catalog row). Hook installation therefore has to cover both roots. Each is a plain
// ClaudeHookService because qodercli implements every event in CLAUDE_EVENTS and reads the same
// settings shape; only the fan-out below is qodercli-specific.
const globalService = new ClaudeHookService({
  agent: 'qodercli',
  displayName: 'Qoder CLI',
  settings: QODERCLI_HOOK_SETTINGS
})

const cnService = new ClaudeHookService({
  agent: 'qodercli',
  displayName: 'Qoder CLI CN',
  settings: QODERCLI_CN_HOOK_SETTINGS
})

function cnConfigDirExists(): boolean {
  return existsSync(join(homedir(), QODERCLI_CN_HOOK_SETTINGS.configDirName))
}

// Why: never create `~/.qoder-cn`. Its absence means the CN build isn't installed, and writing
// hooks there would leave a config root for a CLI the user does not have.
function runBoth(
  run: (service: ClaudeHookService) => AgentHookInstallStatus
): AgentHookInstallStatus {
  const globalStatus = run(globalService)
  if (!cnConfigDirExists()) {
    return globalStatus
  }
  return combineQoderCliHookStatuses(globalStatus, run(cnService))
}

// Why: the two roots are one agent to the rest of Orca, so their two statuses have to collapse to
// one. A disagreement is reported as 'partial' rather than being hidden behind whichever ran first.
// Exported for unit test: this is the only qodercli-specific logic in the file.
export function combineQoderCliHookStatuses(
  globalStatus: AgentHookInstallStatus,
  cnStatus: AgentHookInstallStatus
): AgentHookInstallStatus {
  if (globalStatus.state === cnStatus.state) {
    return {
      ...globalStatus,
      managedHooksPresent: globalStatus.managedHooksPresent && cnStatus.managedHooksPresent,
      detail: mergeDetail(globalStatus, cnStatus)
    }
  }
  return {
    ...globalStatus,
    state: 'partial',
    managedHooksPresent: globalStatus.managedHooksPresent || cnStatus.managedHooksPresent,
    detail: mergeDetail(globalStatus, cnStatus)
  }
}

function mergeDetail(
  globalStatus: AgentHookInstallStatus,
  cnStatus: AgentHookInstallStatus
): string | null {
  const parts = [
    globalStatus.detail ? `${QODERCLI_HOOK_SETTINGS.configDirName}: ${globalStatus.detail}` : null,
    cnStatus.detail ? `${QODERCLI_CN_HOOK_SETTINGS.configDirName}: ${cnStatus.detail}` : null
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join('; ') : null
}

export const qoderCliHookService = {
  install: (): AgentHookInstallStatus => runBoth((service) => service.install()),
  remove: (): AgentHookInstallStatus => runBoth((service) => service.remove()),
  getStatus: (): AgentHookInstallStatus => runBoth((service) => service.getStatus()),
  // Why: must exist and be registered in REMOTE_MANAGED_HOOK_INSTALLERS, or qodercli status
  // silently never appears over SSH — the issue #7253 bug class that
  // remote-hook-service-installers.test.ts guards.
  // Why global root only: the CN fan-out is gated on a LOCAL existsSync, which says nothing about
  // the remote host, and this must never create `~/.qoder-cn` on a box that lacks the CN build.
  // A CN-only remote is not covered; that needs a remote stat and is out of scope here.
  installRemote: (sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> =>
    globalService.installRemote(sftp, remoteHome)
}
