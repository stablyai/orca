import { defineMethod } from '../../core'
import { agentHookServer } from '../../../../agent-hooks/server'
import { TerminalContinueAfterUsageLimit } from '../../../../../shared/rpc-contract/terminal-unary-params'
import type { TerminalUsageLimitContinuationResult } from '../../../../../shared/terminal-usage-limit-continuation'
import { terminalInputSourceForClient } from './terminal-input-delivery'

export const TERMINAL_USAGE_LIMIT_METHODS = [
  defineMethod({
    name: 'terminal.continueAfterUsageLimit',
    permission: 'workspace',
    params: TerminalContinueAfterUsageLimit,
    handler: async (
      params,
      { runtime, caller, signal }
    ): Promise<TerminalUsageLimitContinuationResult> => {
      const paneKey = runtime.getLiveTerminalPaneKey(params.terminal)
      const isCurrent = paneKey
        ? agentHookServer.prepareTerminalUsageLimitContinuation(paneKey, params)
        : null
      if (!isCurrent) {
        return { status: 'refused', reason: 'changed' }
      }
      return runtime.continueTerminalUsageLimit(
        params.terminal,
        isCurrent,
        terminalInputSourceForClient(params.client, caller),
        signal
      )
    }
  })
]
