import { launchOrdinaryTerminalAgent } from './ordinary-automation-agent-launch'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { launchAgentOnHost } from '../runtime/rpc/methods/agent-launch'
import { findReusableAutomationRun } from '../../shared/automation-session-reuse'
import { buildHeadlessAutomationWorkspaceName } from './headless-workspace-create'
import type { AutomationRunTargetResult } from './run-target-resolution'
import {
  AutomationRunLaunchError,
  type HeadlessAutomationDispatchLaunch
} from './headless-dispatch'
import {
  publishedLaunchTarget,
  enrichAutomationRunTarget,
  automationRunAcceptedTarget
} from './automation-agent-run-result'
export { publishedLaunchTarget } from './automation-agent-run-result'
import { automationRunOperationId, AUTOMATION_AGENT_CALLER } from './automation-run-operation'
import { createAutomationDispatchToken } from './dispatch-tokens'
import { mergeExtraAgentArgs, hasExtraAgentArgs } from '../../shared/automation-extra-agent-args'
import { resolveTuiAgentLaunchArgs } from '../../shared/tui-agent-launch-defaults'
import { agentLaunchQuotingShell } from '../../shared/agent-launch-runtime'
import {
  resolveAgentLaunchRuntime,
  newWorktreeLaunchScope
} from '../runtime/agent-launch-scope-runtime'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import type { AgentPromptExpectedBinding } from '../runtime/runtime-terminal-contracts'
import type { AutomationRunWatchReservation } from './run-completion-watcher'
import { tuiAgentDisplayName } from '../../shared/tui-agent-display-names'

export type HeadlessAutomationAgentLaunch = HeadlessAutomationDispatchLaunch & {
  terminalHandle: string | null
}

export type AutomationAgentLaunchRequest = {
  automation: Automation
  run: Pick<AutomationRun, 'id' | 'title' | 'scheduledFor' | 'createdAt' | 'trigger'>
  target: Extract<AutomationRunTargetResult, { ok: true }>
  runs: readonly AutomationRun[]
  observation?: AutomationRunWatchReservation
}

export async function launchHeadlessAutomationAgent(
  runtime: OrcaRuntimeService,
  request: AutomationAgentLaunchRequest
): Promise<HeadlessAutomationAgentLaunch> {
  if (!request.automation.reuseSession) {
    return launchOrdinaryTerminalAgent(runtime, request)
  }
  try {
    return await enrichAutomationRunTarget(runtime, await launchAutomationAgent(runtime, request))
  } catch (error) {
    if (error instanceof AutomationRunLaunchError) {
      throw error
    }
    console.error('[automations] agent launch failed:', error)
    throw new Error(
      `${tuiAgentDisplayName(request.automation.agentId) ?? 'The agent'} could not confirm this run's prompt. Open its workspace before running again.`
    )
  }
}

async function launchAutomationAgent(
  runtime: OrcaRuntimeService,
  request: AutomationAgentLaunchRequest
): Promise<HeadlessAutomationAgentLaunch> {
  const { automation, run, target } = request
  const surface = 'terminal' as const
  const context = { runtime, caller: AUTOMATION_AGENT_CALLER }
  let published: HeadlessAutomationAgentLaunch | undefined
  let binding: AgentPromptExpectedBinding | undefined
  let submitted = false
  const policy = {
    signal: request.observation?.signal,
    allowBusy: true,
    wslUserAct: run.trigger !== 'scheduled',
    assertCurrent: () => {
      request.observation?.assertCurrent()
      if (binding && published?.terminalHandle) {
        const current = runtime.getTerminalPromptRequestBinding(published.terminalHandle)
        if (
          current.ptyId !== binding.ptyId ||
          current.processIncarnation !== binding.processIncarnation
        ) {
          throw new Error('terminal_handle_stale')
        }
      }
    },
    get expectedBinding() {
      return binding
    },
    onSubmitWritten: () => {
      submitted = true
      if (request.observation) {
        request.observation.submitted()
      }
    },
    onSurfacePublished: (result: AgentLaunchResult) => {
      published = publishedLaunchTarget(runtime, result)
      if (published.terminalHandle && request.observation) {
        binding = runtime.getTerminalPromptRequestBinding(published.terminalHandle)
        const original = binding
        const handle = published.terminalHandle
        request.observation.bind({ ...request.run, ...published }, handle, () => {
          try {
            const current = runtime.getTerminalPromptRequestBinding(handle)
            return (
              current.ptyId === original.ptyId &&
              current.processIncarnation === original.processIncarnation
            )
          } catch {
            return false
          }
        })
      }
    },
    terminalTitle: run.title,
    suppressStartupUpdatePrompt: true,
    unprovableHost: 'write-unless-shell'
  } as const
  if (automation.reuseSession && automation.workspaceId) {
    const reused = findReusableAutomationRun({
      automationId: automation.id,
      agentId: automation.agentId,
      worktreeId: automation.workspaceId,
      currentRunId: run.id,
      runs: request.runs.filter((entry) => entry.sessionKind === 'terminal'),
      agentStatusForPane: (paneKey) =>
        runtime
          .getAgentStatusRowsForPane(paneKey)
          .filter((row) => !row.providerSessionOnly)
          .toSorted((a, b) => b.receivedAt - a.receivedAt)[0],
      liveSession: (previous) => runOwnHandle(runtime, previous)
    })
    if (reused) {
      published = publishedLaunchTarget(runtime, {
        worktreeId: automation.workspaceId,
        outcome: { kind: 'terminal', handle: reused }
      })
      const operationId = automationRunOperationId(run, 'reuse-send')
      try {
        const result = await launchAgentOnHost(
          {
            agent: automation.agentId,
            operationId,
            target: { kind: 'existing', worktree: `id:${automation.workspaceId}` },
            surface,
            reuseTerminal: { handle: reused },
            prompt: { text: automation.prompt, delivery: 'submit' },
            presentation: 'background'
          },
          context,
          policy
        )
        published ??= publishedLaunchTarget(runtime, result)
        if (result.prompt?.outcome === 'handed-to-terminal') {
          return publishedLaunchTarget(runtime, result)
        }
        throw new AutomationRunLaunchError(
          `${tuiAgentDisplayName(automation.agentId)} could not confirm this run's prompt. Open the terminal before running again.`,
          published
        )
      } catch (error) {
        if (submitted && published) {
          return published
        }
        const records = await runtime.openAgentSessionRecordStore()
        const row = records.getOperationRow(
          rpcCallerOperationKey(AUTOMATION_AGENT_CALLER),
          operationId
        )
        // Only the launch owner's durable no-effect verdict permits a different launch.
        if (row?.outcome.status !== 'failed') {
          return automationRunAcceptedTarget(runtime, run, published, error, automation.agentId)
        }
        published = undefined
        binding = undefined
        submitted = false
      }
    }
  }
  const operationId = automationRunOperationId(run, 'fresh-launch')
  const settings = runtime.requireStore().getSettings()
  let merged: ReturnType<typeof mergeExtraAgentArgs> | null = null
  if (surface === 'terminal' && hasExtraAgentArgs(automation.extraAgentArgs)) {
    const scope =
      automation.workspaceMode === 'existing' && automation.workspaceId
        ? await runtime.showTerminalWorkspaceLaunchScope(`id:${automation.workspaceId}`)
        : newWorktreeLaunchScope(target.repo, settings)
    merged = mergeExtraAgentArgs({
      agent: automation.agentId,
      extraAgentArgs: automation.extraAgentArgs,
      defaultArgs: resolveTuiAgentLaunchArgs(automation.agentId, settings),
      shell: agentLaunchQuotingShell(
        resolveAgentLaunchRuntime(runtime.requireStore(), scope, undefined, automation.agentId)
      )
    })
  }
  if (merged && !merged.ok) {
    throw new AutomationRunLaunchError(
      `${tuiAgentDisplayName(automation.agentId)} could not start. ${merged.error}`
    )
  }
  try {
    const result = await launchAgentOnHost(
      {
        agent: automation.agentId,
        operationId,
        surface,
        presentation: 'background',
        prompt: { text: automation.prompt, delivery: 'submit' },
        ...(merged?.ok ? { agentArgs: merged.agentArgs } : {}),
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
      context,
      policy
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
    if (submitted && published) {
      return published
    }
    return automationRunAcceptedTarget(runtime, run, published, error, automation.agentId)
  }
}

/** A pane may have been reused by a later process. */
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
