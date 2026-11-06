import {
  decideAgentLaunchMode,
  resolveAgentLaunchModeOnHost
} from '../agent-launch/agent-launch-mode'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { launchAgentOnHost } from '../runtime/rpc/methods/agent-launch'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import {
  isAgentLaunchResult,
  type AgentLaunchResult
} from '../../shared/agent-launch/contracts/agent-launch-intent'
import type {
  FollowUpAction,
  FollowUpObservation,
  FollowUpTarget
} from '../../shared/pr-follow-ups/contracts'
import type { AgentLaunchParams } from '../../shared/rpc-contract/agent-launch-params'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { PRCheckDetail, PRCheckRunDetails } from '../../shared/github/check-types'
import {
  buildFixBrokenChecksPrompt,
  collectFixChecksPromptDetails
} from '../../shared/source-control/checks/pr-checks-fix-prompt'
import { resolveSourceControlActionRecipe } from '../../shared/source-control/ai/source-control-ai-operation-policy'
import { renderSourceControlActionCommandTemplate } from '../../shared/source-control/ai/recipes/source-control-ai-actions'
import {
  sourceControlActionAgentArgs,
  sourceControlActionLaunchOptions,
  resolveSourceControlActionPreferredSurface,
  resolveSourceControlActionRequestedSurface
} from '../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import type { FollowUpReceipt } from './engine'
import { followUpFailureCopy } from './failure'

// Transport identity stays host-owned; the operation domain separates these launches from schedules.
const CALLER = { kind: 'local-cli' } as const

function receipt(runtime: OrcaRuntimeService, result: AgentLaunchResult): FollowUpReceipt {
  const promptUnconfirmed =
    result.prompt?.outcome !== 'journaled' && result.prompt?.outcome !== 'handed-to-terminal'
  const outcome = result.outcome
  return {
    status: 'accepted',
    identity:
      outcome.kind === 'structured'
        ? { surface: 'chat', sessionId: outcome.sessionId, promptUnconfirmed }
        : {
            surface: 'terminal',
            terminalHandle: outcome.handle,
            paneKey: outcome.paneKey,
            terminalPtyId: runtime.getTerminalPtyIdForHandle(outcome.handle) ?? undefined,
            promptUnconfirmed
          }
  }
}

export async function recoverFollowUpLaunch(
  runtime: OrcaRuntimeService,
  action: Pick<FollowUpAction, 'operationId' | 'agent'>
): Promise<FollowUpReceipt> {
  try {
    const store = await runtime.openAgentSessionRecordStore()
    const row = store.getOperationRow(rpcCallerOperationKey(CALLER), action.operationId)
    if (row?.outcome.status === 'succeeded' && isAgentLaunchResult(row.outcome.launch)) {
      return receipt(runtime, row.outcome.launch)
    }
    if (row?.outcome.status === 'failed') {
      if (row.expiresAt !== undefined && row.expiresAt <= Date.now()) {
        return { status: 'unconfirmed' }
      }
      if (row.outcome.code === 'agent_launch_tab_closed') {
        return { status: 'declined' }
      }
      if (
        ['agent_session_operation_unknown', 'agent_session_operation_expired'].includes(
          row.outcome.code
        )
      ) {
        return { status: 'unconfirmed' }
      }
      // Only the ledger's recorded effect-free failure grants another attempt.
      return {
        status: 'absent',
        failureReason: followUpFailureCopy(action.agent, row.outcome.code)
      }
    }
  } catch {
    /* A failed receipt read cannot authorize another launch. */
  }
  return { status: 'unconfirmed' }
}

export async function launchFollowUp(
  runtime: OrcaRuntimeService,
  params: AgentLaunchParams
): Promise<FollowUpReceipt> {
  try {
    return receipt(runtime, await launchAgentOnHost(params, { runtime, caller: CALLER }))
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'agent_launch_tab_closed'
    ) {
      return { status: 'declined' }
    }
    return params.operationId
      ? recoverFollowUpLaunch(runtime, { operationId: params.operationId, agent: params.agent })
      : { status: 'unconfirmed' }
  }
}

export async function prepareFollowUpLaunch(args: {
  runtime: OrcaRuntimeService
  observation: FollowUpObservation
  names: string[]
  target: FollowUpTarget
  settings: GlobalSettings
  repo: Repo
  pr: { number: number; title: string; url: string }
  checks: PRCheckDetail[]
  loadDetails(check: PRCheckDetail): Promise<PRCheckRunDetails | null>
}): Promise<AgentLaunchParams> {
  const recipe = resolveSourceControlActionRecipe({
    settings: args.settings,
    repo: args.repo,
    actionId: 'fixChecks'
  })
  const agent = recipe.agentId ?? args.settings.defaultTuiAgent
  if (!isTuiAgent(agent)) {
    throw new Error('Choose an agent for Fix failing checks in Source Control AI settings')
  }
  const mode = await resolveAgentLaunchModeOnHost(
    args.runtime,
    decideAgentLaunchMode({
      placement: { agent, ...(args.repo.connectionId ? { on: args.repo.connectionId } : {}) },
      settings:
        resolveSourceControlActionPreferredSurface(recipe, agent) === 'chat'
          ? {
              ...args.settings,
              nativeChatProviders: { ...args.settings.nativeChatProviders, [agent]: true }
            }
          : args.settings,
      surface: resolveSourceControlActionRequestedSurface(recipe, agent)
    }),
    args.target.worktreeId,
    agent
  )
  const checks = args.checks.filter((check) => args.names.includes(check.name))
  const details = await collectFixChecksPromptDetails(checks, args.loadDetails)
  const basePrompt = buildFixBrokenChecksPrompt({
    reviewNumber: args.pr.number,
    reviewTitle: args.pr.title,
    reviewUrl: args.pr.url,
    checks,
    checkRunDetailsByCheckKey: details
  })
  const prompt = renderSourceControlActionCommandTemplate(
    recipe.commandInputTemplate ?? '{basePrompt}',
    { basePrompt }
  )
  const options = sourceControlActionLaunchOptions(recipe, agent)
  return {
    agent,
    target: { kind: 'existing', worktree: `id:${args.target.worktreeId}` },
    surface: mode.mode === 'structured' ? 'chat' : 'terminal',
    presentation: 'background',
    agentArgs: sourceControlActionAgentArgs(recipe, agent, args.settings),
    ...(options.sessionOptions ? { sessionOptions: { ...options.sessionOptions } } : {}),
    ...(options.chatSessionOptions ? { chatOptions: { ...options.chatSessionOptions } } : {}),
    prompt: {
      delivery: 'submit',
      text: [
        `Started automatically because ${args.names.length} ${args.names.length === 1 ? 'check' : 'checks'} failed on PR #${args.pr.number}. Turn this off in Project settings → Source Control AI.`,
        `Before working, check that the checkout matches PR head ${args.observation.headSha}; if it differs, bring the branch to that head with git pull --ff-only.`,
        'Do not commit or discard changes you did not make. If uncommitted changes prevent updating the checkout, ask the user before continuing.',
        '',
        prompt
      ].join('\n')
    }
  }
}
