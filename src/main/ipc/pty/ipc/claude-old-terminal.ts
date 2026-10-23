import {
  getClaudeProfileRouter,
  getClaudeWslProfileRouter
} from '../../../claude-accounts/claude-profile-installed-router'
import { getPtyIpc } from '../../pty-host-bindings'
import {
  CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION,
  CLAUDE_ACCOUNT_FUNCTION_REVERTED_DAEMON_PROTOCOL_VERSION
} from '../../../daemon/daemon-protocol-version'
import { isTerminalOnLegacyDaemon } from '../../../daemon/daemon-provider-state'

// Why not every older daemon: v42 shipped the same claude function and pointer; only v43, the revert, lacked them.
function lacksClaudeFunction(protocolVersion: number): boolean {
  return (
    protocolVersion < CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION ||
    protocolVersion === CLAUDE_ACCOUNT_FUNCTION_REVERTED_DAEMON_PROTOCOL_VERSION
  )
}

type Deps = { getLocalPtyProviderStartupPromise: () => Promise<void> | undefined }

/** Whether a pane's daemon predates the claude function, so its claude runs another account. */
export function installPtyClaudeOldTerminalIpcHandler(deps: Deps): void {
  getPtyIpc().handle(
    'pty:openedBeforeClaudeAccounts',
    async (_event, args: { id: unknown; target?: unknown }): Promise<boolean> => {
      const target = paneTarget(args?.target)
      if (typeof args?.id !== 'string' || !target) {
        return false
      }
      // Why: the pre-swap provider does not own restored daemon ids.
      await deps.getLocalPtyProviderStartupPromise()
      if (!isTerminalOnLegacyDaemon(args.id, lacksClaudeFunction)) {
        return false
      }
      // Why the pane's own runtime: claude there runs that runtime's System default.
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
