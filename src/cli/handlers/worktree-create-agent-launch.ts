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
  frozenDefaultRecoveryArgs,
  parseCliAgent,
  readCliAgentLaunch,
  resolveCliDefaultAgent,
  type CliAgentLaunch,
  type ResolvedCliDefaultAgent,
  SURFACE_UNSUPPORTED_MESSAGE
} from '../agent-launch-request'
import { formatWorktreeShow, printResult } from '../format'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { printLineageSummary } from './worktree-lineage-summary'
import { printHookWarning } from './worktree-removal-warnings'
import { withSetupDecisionRecovery } from './worktree-setup-decision-recovery'
import { withCliAgentLaunchRecovery } from '../agent-launch-recovery'
import { getPresentStringFlag } from '../flags'
import type { TuiAgent } from '../../shared/tui-agent'

export function getOptionalStartupAgent(
  flags: Map<string, string | boolean>
): TuiAgent | 'default' | undefined {
  const agent = getPresentStringFlag(flags, 'agent')
  if (agent === undefined) {
    const needsAgent = ['prompt', 'model', 'effort', 'surface', 'retry-launch'].find((name) =>
      flags.has(name)
    )
    if (needsAgent) {
      throw new RuntimeClientError('invalid_argument', `--${needsAgent} requires --agent`)
    }
    return undefined
  }
  return agent === 'default' ? 'default' : parseCliAgent(agent)
}

export async function createWorktreeWithDefaultAgent(args: {
  client: RuntimeClient
  flags: Map<string, string | boolean>
  create: Record<string, unknown>
  repoTarget: { repo: string; repoHostId?: string }
  json: boolean
  rawArgs?: readonly string[]
}): Promise<void> {
  const capabilities = await getAgentLaunchCapabilities(args.client)
  const resolvedAgent = await resolveCliDefaultAgent(args.client, args.repoTarget, capabilities)
  const launch = readCliAgentLaunch(args.flags, resolvedAgent.agent, { createsWorktree: true })
  await createWorktreeWithAgent({
    ...args,
    launch,
    rawArgs: frozenDefaultRecoveryArgs(args.rawArgs, resolvedAgent.agent),
    capabilities: capabilities ?? undefined,
    resolvedAgent
  })
}

type WorktreeAgentLaunchResult = Pick<
  RuntimeWorktreeCreateResult,
  'lineage' | 'workspaceLineage'
> & {
  /** Absent only when the host could not show the worktree it just created. */
  worktree?: RuntimeWorktreeRecord
  launch: AgentLaunchResult & { resolvedAgent?: ResolvedCliDefaultAgent }
}

export async function createWorktreeWithAgent(args: {
  client: RuntimeClient
  flags: Map<string, string | boolean>
  create: Record<string, unknown>
  launch: CliAgentLaunch
  json: boolean
  rawArgs?: readonly string[]
  capabilities?: readonly string[]
  resolvedAgent?: ResolvedCliDefaultAgent
}): Promise<void> {
  const { client, flags, create, launch, json, rawArgs, resolvedAgent } = args
  const capabilities = args.capabilities ?? (await getAgentLaunchCapabilities(client))
  if (
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
      launchSource: 'cli'
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
    launch: { ...launched.result, ...(resolvedAgent ? { resolvedAgent } : {}) }
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
