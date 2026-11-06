import type { ClaudeAuthProxyStatus } from '../../../../shared/claude-auth-proxy-status'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { claudeAuthProxyStatus as readClaudeAuthProxyStatus } from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-host'
import {
  assignClaudePaneOnExecutionHost,
  type AssignClaudePaneRequest
} from '../../../claude-accounts/claude-pane-account-assign'
import type { ClaudeAccountService } from '../../../claude-accounts/service'

/** Claude account policy the runtime RPC exposes. Beside the account controller so that file stays within the line limit. */
export class RuntimeClaudePolicyController {
  constructor(private readonly claudeAccounts: () => ClaudeAccountService) {}

  setAutoSwitch(enabled: boolean): ClaudeRateLimitAccountsState {
    return this.claudeAccounts().setAutoSwitch(enabled)
  }

  setAuthProxy(enabled: boolean): ClaudeRateLimitAccountsState {
    return this.claudeAccounts().setAuthProxy(enabled)
  }

  /** Live listener. Does not require the account service: the proxy is process-global. */
  authProxyStatus(): ClaudeAuthProxyStatus {
    return readClaudeAuthProxyStatus()
  }

  /** Works without account services: a WSL guest has the proxy and the pane registry, not the desktop's accounts. */
  assignPane(request: AssignClaudePaneRequest): { assigned: boolean } {
    return assignClaudePaneOnExecutionHost(request)
  }
}
