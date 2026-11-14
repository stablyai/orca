import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import {
  findReusableAutomationRun,
  isIdleAgentOf,
  latestAutomationSessionRun
} from '../../../shared/automations/history/automation-session-reuse'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { deliverTerminalAgentLaunchPrompt } from '../../runtime/rpc/methods/agent-launch/agent-launch-terminal-prompt'
import { AutomationRunLaunchError } from './automation-launch'
import type { AutomationTerminalAgentLaunch } from './automation-terminal-launch'
import type { AutomationRunTargetResult } from '../ownership/run-target-resolution'

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
  const agentStatusForPane = (paneKey: string) =>
    runtime
      .getAgentStatusRowsForPane(paneKey)
      .filter((row) => !row.providerSessionOnly)
      .toSorted((left, right) => right.receivedAt - left.receivedAt)[0]
  // Link a refused run to its kept pane without claiming an unverified PTY.
  const keptPaneRefusal = (message: string, paneKey: string) =>
    new AutomationRunLaunchError(message, {
      workspaceId: worktreeId,
      workspaceDisplayName,
      terminalSessionId: parsePaneKey(paneKey)?.tabId ?? previous.terminalSessionId,
      terminalPaneKey: paneKey,
      terminalPtyId: null
    })
  let session = findReusableAutomationRun({
    automationId: automation.id,
    agentId: automation.agentId,
    worktreeId,
    target,
    currentRunId: request.run.id,
    runs: [previous],
    agentStatusForPane,
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
    const paneKey = previous.terminalPaneKey!
    const saved = recorded.sessions.find((entry) => entry.paneKey === paneKey)
    if (!saved) {
      // A closed pane has no saved conversation to resume; keep fresh-session compatibility.
      if (!runtime.getTerminalHandleForPaneKey(paneKey)) {
        return null
      }
      throw keptPaneRefusal('The previous automation pane is not ready for reuse.', paneKey)
    }
    const restored = await runtime
      .resumeRecordedAgentSession(
        `id:${worktreeId}`,
        { paneKey: saved.paneKey, agent: automation.agentId, sessionId: saved.providerSession.id },
        { automatic: request.run.trigger === 'scheduled' }
      )
      .catch((error: unknown) => {
        throw keptPaneRefusal(error instanceof Error ? error.message : String(error), saved.paneKey)
      })
    if (restored.disposition === 'adopted') {
      // An adopted conversation was already running; prompt it only when idle, as live reuse does.
      const status = agentStatusForPane(restored.paneKey)
      if (!status || !isIdleAgentOf(status, automation.agentId)) {
        throw keptPaneRefusal(
          'The original automation conversation is not idle; this prompt was not delivered.',
          restored.paneKey
        )
      }
    }
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

export type RunOwnHandleRuntime = Pick<
  OrcaRuntimeService,
  'getTerminalHandleForPaneKey' | 'getTerminalPtyIdForHandle' | 'getPtyLivenessVerdict'
>

/** Reject reused pane handles whose PTY no longer belongs to this run, or has exited. */
export function runOwnHandle(runtime: RunOwnHandleRuntime, run: AutomationRun): string | null {
  const handle = run.terminalPaneKey
    ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey)
    : null
  // A closed pane's handle still resolves to its PTY for exit waits; only the exit verdict tells.
  return handle &&
    run.terminalPtyId &&
    runtime.getTerminalPtyIdForHandle(handle) === run.terminalPtyId &&
    runtime.getPtyLivenessVerdict(run.terminalPtyId)?.status !== 'exited'
    ? handle
    : null
}
