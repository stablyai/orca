import { removeAppHandler, registerAppHandler } from '../app-registry/app-handler-registry'

import type {
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentInterruptInferenceRequest } from '../../../shared/agent-status/lifecycle/agent-interrupt-intent'
import type { AgentQuestionAnsweredInferenceRequest } from '../../../shared/agent-status/lifecycle/agent-question-answered-intent'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import { getMigrationUnsupportedPtySnapshot } from '../../agent-hooks/observations/migration-unsupported-pty-state'
import { registerAgentPaneAuthorityIpcHandlers } from './agent-pane-authority-ipc'
import { registerAgentStatusRowTeardownIpcHandlers } from './agent-status-row-teardown-ipc'
import { createAgentPaneAuthorityOwnership } from './agent-pane-authority-ownership'
import {
  enrichAgentStatusIpcPayload,
  type AgentStatusRuntimeEnrichment
} from './agent-status-ipc-boundary'

type AgentHookHandlerDependencies = {
  getPtyIdForPaneKey?: (paneKey: string) => string | undefined
}

// Startup auto-installs hooks; renderer removal would misleadingly revert on the next launch.
export function registerAgentHookHandlers(
  runtime?: AgentStatusRuntimeEnrichment,
  dependencies: AgentHookHandlerDependencies = {}
): void {
  // Allow safe re-registration independently of the outer module guard.
  removeAppHandler('agentStatus:getSnapshot')
  removeAppHandler('agentStatus:inferInterrupt')
  removeAppHandler('agentStatus:inferQuestionAnswered')
  removeAppHandler('agentStatus:hasVerifiableAgentProcess')
  removeAppHandler('agentStatus:getMigrationUnsupportedSnapshot')
  registerAgentStatusRowTeardownIpcHandlers()
  registerAgentPaneAuthorityIpcHandlers({
    ownsPty: createAgentPaneAuthorityOwnership({
      getPtyIdForPaneKey: dependencies.getPtyIdForPaneKey,
      getRuntimeTerminalHandleForPaneKey: (paneKey) =>
        runtime?.getAgentStatusTerminalHandleForPaneKey(paneKey)
    })
  })
  registerAppHandler('agentStatus:getSnapshot', (): AgentStatusIpcPayload[] => {
    // Pull after workspace hydration to replay enriched statuses without losing startup rows.
    return (
      agentHookServer
        .getStatusSnapshot()
        // Same rule as the live push: the renderer's feed bridge owns structured rows for now.
        .filter((entry) => entry.structuredHost === undefined)
        .map((entry) => enrichAgentStatusIpcPayload(entry, runtime))
    )
  })
  registerAppHandler('agentStatus:inferInterrupt', (_event, request: unknown): boolean => {
    if (typeof request !== 'object' || request === null) {
      return false
    }
    return agentHookServer.inferInterrupt(request as AgentInterruptInferenceRequest)
  })
  registerAppHandler('agentStatus:inferQuestionAnswered', (_event, request: unknown): boolean => {
    if (typeof request !== 'object' || request === null) {
      return false
    }
    return agentHookServer.inferQuestionAnswered(request as AgentQuestionAnsweredInferenceRequest)
  })
  registerAppHandler('agentStatus:hasVerifiableAgentProcess', (_event, paneKey: unknown): boolean =>
    typeof paneKey === 'string' ? agentHookServer.hasVerifiableAgentProcess(paneKey) : false
  )
  registerAppHandler(
    'agentStatus:getMigrationUnsupportedSnapshot',
    (): MigrationUnsupportedPtyEntry[] => getMigrationUnsupportedPtySnapshot()
  )
}
