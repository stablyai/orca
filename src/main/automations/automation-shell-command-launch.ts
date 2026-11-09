import { randomUUID } from 'node:crypto'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  requireWorkspaceId,
  resolveLocalExistingWorkspace,
  runTargetOf,
  type AutomationTerminalAgentLaunch
} from './automation-terminal-launch'
import { buildAutomationWorktreeCreateArgs } from './automation-workspace-create'
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationService } from './service'

/** Runs a blank-terminal automation's command in a PTY that exits with the command. */
export async function launchAutomationShellCommand(
  runtime: OrcaRuntimeService,
  service: Pick<AutomationService, 'markDispatchResult'>,
  request: {
    automation: Automation
    run: Pick<AutomationRun, 'id' | 'title' | 'scheduledFor' | 'trigger'>
    target: Extract<AutomationRunTargetResult, { ok: true }>
  }
): Promise<AutomationTerminalAgentLaunch> {
  const { automation, run, target } = request
  let workspaceId: string
  let workspaceDisplayName: string | null
  if (automation.workspaceMode === 'new_per_run') {
    const created = await runtime.createManagedWorktree(
      buildAutomationWorktreeCreateArgs({ automation, run, repo: target.repo })
    )
    workspaceId = created.worktree.id
    workspaceDisplayName = created.worktree.displayName ?? null
  } else {
    const selected = await resolveLocalExistingWorkspace(runtime, automation, target)
    workspaceId = requireWorkspaceId(automation)
    workspaceDisplayName = selected.managedWorktree?.displayName ?? null
  }
  const tabId = randomUUID()
  const leafId = randomUUID()
  const terminalPaneKey = makePaneKey(tabId, leafId)
  // Reserve the pane before spawn so PTY registration can bind the run's incarnation.
  await service.markDispatchResult({
    runId: run.id,
    status: 'dispatching',
    workspaceId,
    workspaceDisplayName,
    terminalSessionId: tabId,
    terminalPaneKey
  })
  const terminal = await runtime.launchAutomationShellTerminal(`id:${workspaceId}`, {
    command: automation.prompt,
    automationRunId: run.id,
    title: run.title,
    tabId,
    leafId,
    ...(run.trigger === 'scheduled' ? {} : { wslUserAct: true as const })
  })
  return runTargetOf(
    { ...terminal, paneKey: terminal.paneKey ?? terminalPaneKey },
    terminal.worktreeId,
    workspaceDisplayName
  )
}
