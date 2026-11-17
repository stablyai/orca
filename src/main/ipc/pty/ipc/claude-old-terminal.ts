import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { parseAppSshPtyId } from '../../../../shared/remote-runtime/ssh/ssh-pty-id'
import { discoverLocalPtyClaudeSession } from '../../../claude-accounts/selection/claude-pane-session-discovery'
import {
  getClaudeProfileRouter,
  getClaudeWslProfileRouter
} from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { getPtyIpc } from '../pty-host-bindings'
import { ptyOwnership } from '../provider/ownership-state'
import {
  CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION,
  CLAUDE_ACCOUNT_FUNCTION_REVERTED_DAEMON_PROTOCOL_VERSION
} from '../../../daemon/protocol/daemon-protocol-version'
import { isTerminalOnLegacyDaemon } from '../../../daemon/providers/lifecycle/daemon-provider-state'

// v42 shipped this function; only earlier protocols and the v43 revert lack it.
function lacksClaudeFunction(protocolVersion: number): boolean {
  return (
    protocolVersion < CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION ||
    protocolVersion === CLAUDE_ACCOUNT_FUNCTION_REVERTED_DAEMON_PROTOCOL_VERSION
  )
}

type Deps = { getLocalPtyProviderStartupPromise: () => Promise<void> | undefined }

export function installPtyClaudeOldTerminalIpcHandler(deps: Deps): void {
  getPtyIpc().handle(
    'pty:openedBeforeClaudeAccounts',
    async (_event, args: { id: unknown; target?: unknown }): Promise<boolean> => {
      const target = paneTarget(args?.target)
      if (typeof args?.id !== 'string' || !target) {
        return false
      }
      // Restored daemon IDs are not owned by the pre-swap provider.
      await deps.getLocalPtyProviderStartupPromise()
      if (!isTerminalOnLegacyDaemon(args.id, lacksClaudeFunction)) {
        return false
      }
      // Use the pane's runtime account selection, including its WSL distro.
      const runsAnother =
        target.runtime === 'wsl'
          ? await getClaudeWslProfileRouter()
              ?.systemDefaultRunsAnotherAccount(target.wslDistro)
              .catch(() => null)
          : getClaudeProfileRouter()?.systemDefaultRunsAnotherAccount()
      return runsAnother === true
    }
  )
  getPtyIpc().removeHandler('pty:discoverClaudeSession')
  getPtyIpc().handle(
    'pty:discoverClaudeSession',
    async (_event, args: { id?: unknown }): Promise<AgentProviderSessionMetadata | null> => {
      const id = args?.id
      if (!isLocalHostPtyId(id)) {
        return null
      }
      await deps.getLocalPtyProviderStartupPromise()
      return discoverLocalPtyClaudeSession(id)
    }
  )
}

function isLocalHostPtyId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    !isRemoteRuntimePtyId(id) &&
    !parseAppSshPtyId(id) &&
    (ptyOwnership.get(id) ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
  )
}

function paneTarget(
  value: unknown
): { runtime: 'host' } | { runtime: 'wsl'; wslDistro: string } | null {
  if (typeof value !== 'object' || value === null || !('runtime' in value)) {
    return null
  }
  if (value.runtime === 'host') {
    return { runtime: 'host' }
  }
  return value.runtime === 'wsl' && 'wslDistro' in value && typeof value.wslDistro === 'string'
    ? { runtime: 'wsl', wslDistro: value.wslDistro }
    : null
}
