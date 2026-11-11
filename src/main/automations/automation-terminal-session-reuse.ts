import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import {
  findReusableAutomationRun,
  latestAutomationSessionRun
} from '../../shared/automations/history/automation-session-reuse'
import { parsePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { deliverTerminalAgentLaunchPrompt } from '../runtime/rpc/methods/agent-launch/agent-launch-terminal-prompt'
import { AutomationRunLaunchError } from './automation-launch'
import type { AutomationTerminalAgentLaunch } from './automation-terminal-launch'
import type { AutomationRunTargetResult } from './run-target-resolution'

export async function sendToReusableSession(
  runtime: OrcaRuntimeService,
  request: {
    automation: Automation
    run: Pick<AutomationRun, 'id' | 'trigger'>
    runs: readonly AutomationRun[]
    text: string
    target: Extract<AutomationRunTargetResult, { ok: true }>
  },
  workspaceDisplayName: string | null,
  physicalHostId: string
): Promise<AutomationTerminalAgentLaunch | null> {
  const { automation, text } = request
  const worktreeId = automation.workspaceId
  if (!worktreeId) {
    throw new Error('The target workspace is no longer available.')
  }
  const target = {
    hostId: getRepoExecutionHostId(request.target.repo),
    repoId: request.target.repo.id,
    path: request.target.repo.path
  }
  const previous = latestAutomationSessionRun({
    automationId: automation.id,
    worktreeId,
    target,
    currentRunId: request.run.id,
    runs: request.runs
  })
  if (!previous) {
    return null
  }
  let session = findReusableAutomationRun({
    automationId: automation.id,
    agentId: automation.agentId,
    worktreeId,
    target,
    currentRunId: request.run.id,
    runs: [previous],
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
  let resumed = false
  if (!session) {
    const recorded = await runtime.listRecordedAgentSessions(`id:${worktreeId}`)
    const saved = recorded.sessions.find((entry) => entry.paneKey === previous.terminalPaneKey)
    if (!saved) {
      // A closed pane has no saved conversation to resume; keep fresh-session compatibility.
      if (!runtime.getTerminalHandleForPaneKey(previous.terminalPaneKey!)) {
        return null
      }
      throw new AutomationRunLaunchError('The previous automation pane is not ready for reuse.')
    }
    const restored = await runtime.resumeRecordedAgentSession(
      `id:${worktreeId}`,
      { paneKey: saved.paneKey, agent: automation.agentId, sessionId: saved.providerSession.id },
      { automatic: request.run.trigger === 'scheduled' }
    )
    session = {
      handle: restored.handle,
      previous: {
        ...previous,
        terminalSessionId: parsePaneKey(restored.paneKey)!.tabId,
        terminalPaneKey: restored.paneKey,
        terminalPtyId: restored.ptyId
      }
    }
    resumed = restored.disposition === 'resumed'
  }
  const deliveryTarget = {
    workspaceId: worktreeId,
    workspaceDisplayName,
    terminalHandle: session.handle,
    terminalSessionId: session.previous.terminalSessionId,
    terminalPaneKey: session.previous.terminalPaneKey,
    terminalPtyId: session.previous.terminalPtyId
  }
  if (
    !(await deliverTerminalAgentLaunchPrompt({
      runtime,
      handle: session.handle,
      agent: automation.agentId,
      freshLaunch: resumed,
      text,
      unprovableHost: 'write-unless-shell'
    }))
  ) {
    throw new AutomationRunLaunchError(
      'The original automation conversation was retained, but this prompt could not be delivered.',
      deliveryTarget
    )
  }
  return {
    workspaceId: worktreeId,
    workspaceDisplayName,
    terminalHandle: session.handle,
    terminalSessionId: session.previous.terminalSessionId,
    terminalPaneKey: session.previous.terminalPaneKey,
    terminalPtyId: session.previous.terminalPtyId
  }
}

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

export async function hasResumableAutomationTerminal(
  runtime: Pick<OrcaRuntimeService, 'listRecordedAgentSessions'>,
  run: AutomationRun
): Promise<boolean> {
  if (!run.workspaceId || !run.terminalPaneKey) {
    return false
  }
  try {
    const recorded = await runtime.listRecordedAgentSessions(`id:${run.workspaceId}`)
    return recorded.sessions.some((entry) => entry.paneKey === run.terminalPaneKey)
  } catch {
    // An unavailable workspace is not proof its resume record disappeared.
    return true
  }
}
