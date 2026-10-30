import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AutomationRun } from '../../shared/automations-types'
import type { AutomationChatAgentLaunch } from './automation-chat-agent-launch'
import { tuiAgentDisplayName } from '../../shared/tui-agent-display-names'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { readAutomationRunReceipt } from './automation-run-receipt'
import { AutomationRunLaunchError } from './headless-dispatch'

export function publishedLaunchTarget(
  runtime: Pick<OrcaRuntimeService, 'getTerminalPaneKey' | 'getTerminalPtyIdForHandle'>,
  result: Pick<AgentLaunchResult, 'worktreeId' | 'outcome'>
): AutomationChatAgentLaunch {
  let paneKey = result.outcome.kind === 'terminal' ? (result.outcome.paneKey ?? null) : null
  let ptyId: string | null = null
  if (result.outcome.kind === 'terminal') {
    try {
      paneKey ??= runtime.getTerminalPaneKey(result.outcome.handle)
    } catch {
      /* Keep publication identity. */
    }
    try {
      ptyId = runtime.getTerminalPtyIdForHandle(result.outcome.handle)
    } catch {
      /* Process evidence is optional for opening. */
    }
  }
  return {
    workspaceId: result.worktreeId,
    workspaceDisplayName: null,
    sessionKind: result.outcome.kind === 'structured' ? 'chat' : 'terminal',
    chatSessionId: result.outcome.kind === 'structured' ? result.outcome.sessionId : null,
    terminalHandle: result.outcome.kind === 'terminal' ? result.outcome.handle : null,
    terminalSessionId: parsePaneKey(paneKey ?? '')?.tabId ?? null,
    terminalPaneKey: paneKey,
    terminalPtyId: ptyId
  }
}

export async function enrichAutomationRunTarget(
  runtime: OrcaRuntimeService,
  target: AutomationChatAgentLaunch
): Promise<AutomationChatAgentLaunch> {
  try {
    const shown = await runtime.showManagedWorktree(`id:${target.workspaceId}`)
    target.workspaceDisplayName = shown.displayName ?? null
  } catch {
    // Publication already owns the target; optional display metadata cannot erase it.
  }
  if (target.terminalHandle && !target.terminalSessionId) {
    try {
      target.terminalSessionId = (await runtime.showTerminal(target.terminalHandle)).tabId ?? null
    } catch {
      // Keep the published pane and process identity when its presentation is unavailable.
    }
  }
  return target
}

/** A lost reply is not proof of no effect; recovery reads the ordinary operation receipt. */
export async function automationRunAcceptedTarget(
  runtime: OrcaRuntimeService,
  run: Pick<AutomationRun, 'id' | 'createdAt'>,
  target: AutomationChatAgentLaunch | undefined,
  error: unknown,
  agent: string
): Promise<AutomationChatAgentLaunch> {
  const receipt = await runtime
    .openAgentSessionRecordStore()
    .then((store) => readAutomationRunReceipt(store, run))
    .catch(() => null)
  if (receipt?.accepted) {
    return receipt.kind === 'terminal'
      ? publishedLaunchTarget(runtime, receipt.launch)
      : {
          workspaceId: receipt.workspaceId,
          workspaceDisplayName: null,
          sessionKind: 'chat',
          chatSessionId: receipt.sessionId,
          terminalHandle: null,
          terminalSessionId: null,
          terminalPaneKey: null,
          terminalPtyId: null
        }
  }
  if (target) {
    throw new AutomationRunLaunchError(
      `${tuiAgentDisplayName(agent)} could not confirm this run's prompt. Open the run before trying again.`,
      target
    )
  }
  throw error
}
