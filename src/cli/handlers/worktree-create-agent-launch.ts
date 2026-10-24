// Use agent.launch for surface/model/effort; older hosts fall back to the create startup terminal.

import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import {
  AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
} from '../../shared/agent-launch-runtime-capability'
import type { RuntimeWorktreeCreateResult, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import {
  callAgentLaunch,
  formatAgentLaunch,
  hasLaunchModelFlags,
  getAgentLaunchCapabilities,
  type CliAgentLaunch,
  SURFACE_UNSUPPORTED_MESSAGE
} from '../agent-launch-request'
import { formatWorktreeShow, printResult } from '../format'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { printLineageSummary } from './worktree-lineage-summary'
import { printHookWarning } from './worktree-removal-warnings'
import { withSetupDecisionRecovery } from './worktree-setup-decision-recovery'
import { withCliAgentLaunchRecovery } from '../agent-launch-recovery'
import { readClaudeLaunchAccountFlag } from './claude-launch-account-flag'

type WorktreeAgentLaunchResult = Pick<
  RuntimeWorktreeCreateResult,
  'lineage' | 'workspaceLineage'
> & {
  /** Absent only when the host could not show the worktree it just created. */
  worktree?: RuntimeWorktreeRecord
  launch: AgentLaunchResult
}

export async function createWorktreeWithAgent(args: {
  client: RuntimeClient
  flags: Map<string, string | boolean>
  create: Record<string, unknown>
  launch: CliAgentLaunch
  json: boolean
  rawArgs?: readonly string[]
}): Promise<void> {
  const { client, flags, create, launch, json, rawArgs } = args
  // Why: only the create's startup terminal can run Claude on a non-active account.
  const claudeAccount = await readClaudeLaunchAccountFlag(flags, client, launch.agent)
  if (claudeAccount && (launch.operationId || launch.surface || hasLaunchModelFlags(flags))) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--account cannot be combined with --model, --effort, --surface or --retry-launch.'
    )
  }
  const capabilities = claudeAccount ? undefined : await getAgentLaunchCapabilities(client)
  if (
    claudeAccount ||
    !capabilities?.includes(AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY) ||
    (launch.prompt && !capabilities.includes(AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY))
  ) {
    if (launch.operationId) {
      throw new RuntimeClientError(
        'agent_session_operation_unknown',
        'This host cannot replay the earlier launch. Return to the original execution host; do not retry without --retry-launch.'
      )
    }
    if (hasLaunchModelFlags(flags)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host cannot start an agent on a chosen model or effort. Update Orca on the execution host, or omit --model and --effort.'
      )
    }
    if (launch.surface) {
      throw new RuntimeClientError('incompatible_runtime', SURFACE_UNSUPPORTED_MESSAGE)
    }
    const params = {
      ...create,
      startupAgent: launch.agent,
      startupPrompt: launch.prompt?.text ?? '',
      launchSource: 'cli',
      ...(claudeAccount ? { startupClaudeAccount: claudeAccount } : {})
    }
    const created = await withSetupDecisionRecovery(
      withCliAgentLaunchRecovery(
        client.call<RuntimeWorktreeCreateResult>('worktree.create', params),
        {
          rawArgs,
          params
        }
      )
    )
    printHookWarning(created.result, json)
    printLineageSummary(created.result, json)
    printResult(created, json, formatWorktreeShow)
    return
  }
  const launched = await withSetupDecisionRecovery(
    callAgentLaunch(
      client,
      launch,
      {
        target: { kind: 'create-worktree', create },
        presentation: create.activate === true ? 'focused' : 'background'
      },
      capabilities,
      rawArgs
    ),
    launch.operationId !== undefined
  )
  const worktree = await showLaunchedWorktree(client, launched.result.worktreeId)
  const result: WorktreeAgentLaunchResult = {
    ...(worktree
      ? {
          worktree,
          lineage: worktree.lineage,
          workspaceLineage: worktree.workspaceLineage ?? null
        }
      : { lineage: null }),
    launch: launched.result
  }
  printLineageSummary(result, json)
  printResult({ ...launched, result }, json, (value) =>
    [
      ...(value.worktree ? [formatWorktreeShow({ worktree: value.worktree })] : []),
      formatAgentLaunch(value.launch)
    ].join('\n')
  )
}

/** Reporting, never a reason to fail: the agent already runs, and a retry would start a second. */
async function showLaunchedWorktree(
  client: RuntimeClient,
  worktreeId: string
): Promise<RuntimeWorktreeRecord | undefined> {
  try {
    const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: `id:${worktreeId}`
    })
    return shown.result.worktree
  } catch {
    return undefined
  }
}
