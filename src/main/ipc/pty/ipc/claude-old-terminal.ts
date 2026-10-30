import {
  getClaudeProfileRouter,
  getClaudeWslProfileRouter
} from '../../../claude-accounts/claude-profile-installed-router'
import { getPtyIpc } from '../pty-host-bindings'
import {
  CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION,
  CLAUDE_ACCOUNT_FUNCTION_REVERTED_DAEMON_PROTOCOL_VERSION
} from '../../../daemon/daemon-protocol-version'
import { isTerminalOnLegacyDaemon } from '../../../daemon/daemon-provider-state'

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
