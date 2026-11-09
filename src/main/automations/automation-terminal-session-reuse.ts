import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import {
  selectAutomationSessionReuse,
  type AutomationSessionReuse
} from '../../shared/automations/history/automation-session-reuse'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { deliverTerminalAgentLaunchPrompt } from '../runtime/rpc/methods/agent-launch/agent-launch-terminal-prompt'
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationTerminalAgentLaunch } from './automation-terminal-launch'

/** Reject reused pane handles whose PTY no longer belongs to this run. */
export function runOwnHandle(
  runtime: Pick<OrcaRuntimeService, 'getTerminalHandleForPaneKey' | 'getTerminalPtyIdForHandle'>,
  run: AutomationRun
): string | null {
  const handle = run.terminalPaneKey
    ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey)
    : null
  return handle &&
    run.terminalPtyId &&
    runtime.getTerminalPtyIdForHandle(handle) === run.terminalPtyId
    ? handle
    : null
}

/**
 * Send the run to the workspace's previous session, or report why that session cannot take it.
 * The reason is what lets a strict automation skip instead of starting a second session.
 */
export async function sendToReusableSession(
  runtime: OrcaRuntimeService,
  request: {
    automation: Automation
    run: Pick<AutomationRun, 'id'>
    runs: readonly AutomationRun[]
    text: string
    target: Extract<AutomationRunTargetResult, { ok: true }>
    worktreeId: string
  },
  workspaceDisplayName: string | null,
  physicalHostId: string
): Promise<AutomationSessionReuse<AutomationTerminalAgentLaunch>> {
  const { automation, text, worktreeId } = request
  const reuse = selectAutomationSessionReuse({
    automationId: automation.id,
    agentId: automation.agentId,
    worktreeId,
    target: {
      hostId: getRepoExecutionHostId(request.target.repo),
      repoId: request.target.repo.id,
      path: request.target.repo.path
    },
    currentRunId: request.run.id,
    runs: request.runs,
    agentStatusForPane: (paneKey) =>
      runtime
        .getAgentStatusRowsForPane(paneKey)
        .filter((row) => !row.providerSessionOnly)
        .toSorted((left, right) => right.receivedAt - left.receivedAt)[0],
    liveSession: (previous) => {
      const handle = runOwnHandle(runtime, previous)
      const liveWorktreeId = handle ? runtime.getTerminalWorktreeIdForHandle(handle) : null
      const liveHostId = handle
        ? runtime.getPtyExecutionHostMetadata(runtime.getTerminalPtyIdForHandle(handle))
            .executionHostId
        : undefined
      return handle && liveWorktreeId === worktreeId && liveHostId === physicalHostId
        ? { handle, previous }
        : null
    }
  })
  if (reuse.outcome !== 'reused') {
    return reuse
  }
  const { session } = reuse
  if (
    !(await deliverTerminalAgentLaunchPrompt({
      runtime,
      handle: session.handle,
      agent: automation.agentId,
      freshLaunch: false,
      text,
      // Windows cannot prove which agent is foreground; refuse only a proven shell.
      unprovableHost: 'write-unless-shell'
    }))
  ) {
    // The session is there but took no prompt, so it cannot be reused either.
    return { outcome: 'blocked', reason: 'sessionNotReusable' }
  }
  return {
    outcome: 'reused',
    session: {
      workspaceId: worktreeId,
      workspaceDisplayName,
      terminalHandle: session.handle,
      terminalSessionId: session.previous.terminalSessionId,
      terminalPaneKey: session.previous.terminalPaneKey,
      terminalPtyId: session.previous.terminalPtyId
    }
  }
}
