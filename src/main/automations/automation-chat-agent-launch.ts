import { automationCanonicalLaunchSetup } from '../../shared/automations/launch/automation-canonical-launch-setup'
import { automationLaunchInputs } from '../../shared/automations/launch/automation-launch-choices'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { launchAgentOnHost } from '../runtime/rpc/methods/agent-launch/agent-launch'
import { reuseAutomationChat } from './automation-chat-session-reuse'
import { buildHeadlessAutomationWorkspaceName } from './automation-workspace-create'
import type { AutomationRunTargetResult } from './run-target-resolution'
import { AutomationRunLaunchError, type AutomationLaunch } from './automation-launch'
import {
  publishedLaunchTarget,
  enrichAutomationRunTarget,
  automationRunAcceptedTarget
} from './automation-agent-run-result'
import { automationRunOperationId, AUTOMATION_AGENT_CALLER } from './automation-run-operation'
import { createAutomationDispatchToken } from './dispatch-tokens'
import { tuiAgentDisplayName } from '../../shared/agent-launch/catalog/tui-agent-display-names'

export type AutomationChatAgentLaunch = AutomationLaunch & {
  terminalHandle: string | null
}

export type AutomationChatLaunchRequest = {
  automation: Automation
  run: Pick<AutomationRun, 'id' | 'title' | 'scheduledFor' | 'createdAt'>
  target: Extract<AutomationRunTargetResult, { ok: true }>
  runs: readonly AutomationRun[]
}

export async function launchAutomationChatAgent(
  runtime: OrcaRuntimeService,
  request: AutomationChatLaunchRequest
): Promise<AutomationChatAgentLaunch> {
  try {
    return await enrichAutomationRunTarget(runtime, await launchChat(runtime, request))
  } catch (error) {
    if (error instanceof AutomationRunLaunchError) {
      throw error
    }
    console.error('[automations] chat launch failed:', error)
    throw new Error(
      `${tuiAgentDisplayName(request.automation.agentId) ?? 'The agent'} could not confirm this run's prompt. Open its workspace before running again.`
    )
  }
}

async function launchChat(
  runtime: OrcaRuntimeService,
  request: AutomationChatLaunchRequest
): Promise<AutomationChatAgentLaunch> {
  const { automation, run, target } = request
  let published: AutomationChatAgentLaunch | undefined
  if (automation.reuseSession && automation.workspaceId) {
    const reused = await reuseAutomationChat(runtime, request)
    if (reused) {
      return reused
    }
  }
  const views = automationLaunchInputs(
    automation.agentId,
    automationCanonicalLaunchSetup(automation)
  )
  const operationId = automationRunOperationId(run, 'fresh-launch')
  try {
    const result = await launchAgentOnHost(
      {
        agent: automation.agentId,
        operationId,
        surface: 'chat',
        ...(views.chatSessionOptions !== undefined
          ? { sessionOptions: {}, chatOptions: views.chatSessionOptions }
          : {}),
        presentation: 'background',
        prompt: { text: automation.prompt, delivery: 'submit' },
        target:
          automation.workspaceMode === 'existing'
            ? { kind: 'existing', worktree: `id:${automation.workspaceId}` }
            : {
                kind: 'create-worktree',
                create: {
                  repo: `id:${target.repo.id}`,
                  name: buildHeadlessAutomationWorkspaceName(run.title, run.scheduledFor),
                  ...(automation.baseBranch ? { baseBranch: automation.baseBranch } : {}),
                  setupDecision: automation.setupDecision ?? 'skip',
                  ...(automation.setupTrustHash
                    ? { approvedSetupHash: automation.setupTrustHash }
                    : {}),
                  activate: false,
                  automationProvenanceRequest: {
                    automationId: automation.id,
                    automationRunId: run.id,
                    dispatchToken: createAutomationDispatchToken(automation.id, run.id),
                    createRequestId: operationId
                  }
                }
              }
      },
      { runtime, caller: AUTOMATION_AGENT_CALLER },
      {
        onSurfacePublished: (surface) => {
          published = publishedLaunchTarget(runtime, surface)
        }
      }
    )
    if (result.prompt?.outcome !== 'journaled' && result.prompt?.outcome !== 'handed-to-terminal') {
      throw new AutomationRunLaunchError(
        `${tuiAgentDisplayName(automation.agentId)} started, but Orca could not confirm this run's prompt. Open the run before trying again.`,
        published ?? publishedLaunchTarget(runtime, result)
      )
    }
    return publishedLaunchTarget(runtime, result)
  } catch (error) {
    if (
      error instanceof Error &&
      ('code' in error
        ? error.code === 'agent_session_operation_expired'
        : error.message.includes('agent_session_operation_expired'))
    ) {
      throw new AutomationRunLaunchError(
        `${tuiAgentDisplayName(automation.agentId)} could not start because this run waited too long. Run the automation again.`
      )
    }
    return automationRunAcceptedTarget(runtime, run, published, error, automation.agentId)
  }
}
