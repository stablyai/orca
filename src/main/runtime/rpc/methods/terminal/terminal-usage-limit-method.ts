import { wslHookRelayManager } from '../../../../agent-hooks/wsl-hook-relay-manager'
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
      const binding = runtime.getTerminalPromptRequestBinding(params.terminal)
      const source = paneKey
        ? agentHookServer.prepareTerminalUsageLimitSource(paneKey, binding.ptyId, params)
        : null
      if (!source) {
        return { status: 'refused', reason: 'changed' }
      }
      try {
        const remote = source.remote
        const guest = remote
          ? wslHookRelayManager.captureUsageLimitValidator(remote.connectionId)
          : null
        if (remote && !guest) {
          return { status: 'refused', reason: 'unavailable' }
        }
        return await runtime.continueTerminalUsageLimit(
          params.terminal,
          () =>
            source.isCurrent() &&
            (!guest || guest.isCurrent()) &&
            runtime.getLiveTerminalPaneKey(params.terminal) === paneKey,
          terminalInputSourceForClient(params.client, caller),
          signal,
          remote && guest ? () => guest.validateSource(remote.request, signal) : undefined,
          source.agent
        )
      } finally {
        source.dispose()
      }
    }
  })
]
