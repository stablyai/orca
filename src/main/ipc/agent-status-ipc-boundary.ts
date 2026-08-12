import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  resolveAuthoritativeCodexApprovalReviewer,
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

function resolveLaunchBoundCodexApprovalReviewer(
  data: Pick<
    AgentStatusIpcPayload,
    'paneKey' | 'agentType' | 'state' | 'hookEventName' | 'launchToken'
  >,
  runtime: AgentStatusRuntimeEnrichment | undefined
): ExplicitCodexApprovalReviewer | undefined {
  if (
    data.agentType !== 'codex' ||
    (data.state !== 'waiting' && data.state !== 'blocked') ||
    data.hookEventName !== 'PermissionRequest'
  ) {
    return undefined
  }
  // Why: only launchToken-scoped agentArgs may prove auto_review; wire stamps are untrusted.
  const launchConfig = runtime?.getAgentStatusLaunchConfigForPaneKey?.(data.paneKey, {
    launchToken: data.launchToken
  })
  const reviewer = resolveAuthoritativeCodexApprovalReviewer({
    agentArgs: launchConfig?.agentArgs
  })
  return reviewer === 'unknown' ? undefined : reviewer
}

export function enrichAgentStatusIpcPayload(
  data: AgentStatusIpcPayload,
  runtime: AgentStatusRuntimeEnrichment | undefined
): AgentStatusIpcPayload {
  if (!runtime) {
    // Why: without runtime launch lookup, drop wire reviewer so consumers fail open.
    const { codexApprovalReviewer: _wire, ...rest } = data
    void _wire
    return rest
  }
  const terminalHandle = runtime.getAgentStatusTerminalHandleForPaneKey(data.paneKey)
  const orchestration = runtime.getAgentStatusOrchestrationContextForPaneKey(data.paneKey)
  const codexApprovalReviewer = resolveLaunchBoundCodexApprovalReviewer(data, runtime)
  // Why: never re-emit an unverified wire stamp; only launch-bound ownership crosses IPC.
  const { codexApprovalReviewer: _wire, ...rest } = data
  void _wire
  return {
    ...rest,
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
      // Why: wire stamp is intentionally not forwarded; enrich re-binds from launchToken.
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
