import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  resolveCodexApprovalReviewer,
  type ExplicitCodexApprovalReviewer
} from '../../shared/codex-approval-reviewer'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export type AgentStatusRuntimeEnrichment = Pick<
  OrcaRuntimeService,
  'getAgentStatusTerminalHandleForPaneKey' | 'getAgentStatusOrchestrationContextForPaneKey'
> &
  Partial<Pick<OrcaRuntimeService, 'getAgentStatusLaunchConfigForPaneKey'>>

const MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH = 160

export function enrichAgentStatusIpcPayload(
  data: AgentStatusIpcPayload,
  runtime: AgentStatusRuntimeEnrichment | undefined
): AgentStatusIpcPayload {
  if (!runtime) {
    return data
  }
  const terminalHandle = runtime.getAgentStatusTerminalHandleForPaneKey(data.paneKey)
  const orchestration = runtime.getAgentStatusOrchestrationContextForPaneKey(data.paneKey)
  let codexApprovalReviewer: ExplicitCodexApprovalReviewer | undefined = data.codexApprovalReviewer
  if (
    data.agentType === 'codex' &&
    (data.state === 'waiting' || data.state === 'blocked') &&
    data.hookEventName === 'PermissionRequest'
  ) {
    if (!codexApprovalReviewer) {
      const launchConfig = runtime.getAgentStatusLaunchConfigForPaneKey?.(data.paneKey, {
        launchToken: data.launchToken
      })
      const reviewer = resolveCodexApprovalReviewer(launchConfig?.agentArgs)
      codexApprovalReviewer = reviewer === 'unknown' ? undefined : reviewer
    }
  }
  return {
    ...data,
    ...(terminalHandle ? { terminalHandle } : {}),
    ...(orchestration ? { orchestration } : {}),
    ...(codexApprovalReviewer ? { codexApprovalReviewer } : {})
  }
}

// Why: live events and startup snapshots must preserve identical hook identity and runtime attribution.
export function buildAgentStatusIpcPayload(
  event: EnrichedAgentHookEventPayload,
  runtime: AgentStatusRuntimeEnrichment | undefined
): AgentStatusIpcPayload {
  return enrichAgentStatusIpcPayload(
    {
      ...event.payload,
      paneKey: event.paneKey,
      ...(event.launchToken ? { launchToken: event.launchToken } : {}),
      ...(event.codexApprovalReviewer
        ? { codexApprovalReviewer: event.codexApprovalReviewer }
        : {}),
      ...(event.hookEventName ? { hookEventName: event.hookEventName } : {}),
      ...(event.tabId ? { tabId: event.tabId } : {}),
      ...(event.worktreeId ? { worktreeId: event.worktreeId } : {}),
      connectionId: event.connectionId,
      receivedAt: event.receivedAt,
      stateStartedAt: event.stateStartedAt,
      ...(event.providerSession ? { providerSession: event.providerSession } : {}),
      ...(event.providerSessionOnly ? { providerSessionOnly: true } : {}),
      ...(event.promptInteractionKey ? { promptInteractionKey: event.promptInteractionKey } : {}),
      ...(event.restoredUnconfirmed ? { restoredUnconfirmed: true } : {})
    },
    runtime
  )
}

export function isValidAgentStatusDropTabId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH &&
    value.trim() === value &&
    isValidTerminalTabId(value)
  )
}
