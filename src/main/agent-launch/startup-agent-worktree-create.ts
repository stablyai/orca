/** Preserve worktree.create’s terminal startup and prompt delivery through the shared executor. */

import type { AgentLaunchPrompt } from '../../shared/agent-launch-intent'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import type { TuiAgent } from '../../shared/tui-agent'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime/runtime-managed-worktree-create-types'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import { AgentLaunchStartupAgentNotCreatedError } from './agent-launch-legacy-host'

type StartupAgentCreateRuntime = AgentLaunchExecution['runtime'] &
  Pick<OrcaRuntimeService, 'createManagedWorktree' | 'showRepo' | 'resolveStartupDraftAgent'>

type StartupAgentLaunch = {
  agent: TuiAgent
  prompt: AgentLaunchPrompt | undefined
  connectionId: string | null
}

export async function createWorktreeWithStartupAgent(
  runtime: StartupAgentCreateRuntime,
  args: RuntimeManagedWorktreeCreateArgs
): Promise<CreateWorktreeResult> {
  const launch = await resolveStartupAgentLaunch(runtime, args)
  if ('passthrough' in launch) {
    return runtime.createManagedWorktree(launch.passthrough)
  }
  let created: CreateWorktreeResult | undefined
  try {
    await executeAgentLaunch({
      runtime,
      intent: {
        agent: launch.agent,
        target: { kind: 'create-worktree', create: args },
        ...(launch.prompt ? { prompt: launch.prompt } : {}),
        ...(args.startupLaunchSource ? { launchSource: args.startupLaunchSource } : {})
      },
      terminalOnly: true,
      promptPolicy: 'legacy-host',
      workspaces: {
        createWorktree: async ({ legacyPrompt, launchSource }) => {
          created = await runtime.createManagedWorktree({
            ...withoutStartupAgentFields(args),
            ...legacyStartupFields(launch.agent, legacyPrompt),
            ...(launchSource ? { startupLaunchSource: launchSource } : {})
          })
          return {
            worktreeId: created.worktree.id,
            connectionId: launch.connectionId,
            startupTerminalHandle: created.startupTerminal?.handle,
            ...(created.startupTerminal?.paneKey
              ? { startupTerminalPaneKey: created.startupTerminal.paneKey }
              : {}),
            ...(created.warning ? { warning: created.warning } : {})
          }
        }
      }
    })
  } catch (error) {
    // Preserve a successful workspace result even when its startup agent did not spawn here.
    if (!(error instanceof AgentLaunchStartupAgentNotCreatedError) || !created) {
      throw error
    }
  }
  if (!created) {
    throw new Error('agent_launch_workspace_not_created')
  }
  return created
}

async function resolveStartupAgentLaunch(
  runtime: StartupAgentCreateRuntime,
  args: RuntimeManagedWorktreeCreateArgs
): Promise<StartupAgentLaunch | { passthrough: RuntimeManagedWorktreeCreateArgs }> {
  if (args.startup || (!args.startupAgent && !args.startupDraft?.trim())) {
    return { passthrough: args }
  }
  const repo = await runtime.showRepo(args.repoSelector)
  const connectionId = getRepoSshConnectionId(repo)
  if (args.startupAgent) {
    return {
      agent: args.startupAgent,
      prompt: args.startupPrompt?.trim()
        ? { text: args.startupPrompt, delivery: 'submit' }
        : undefined,
      connectionId
    }
  }
  const agent = await runtime.resolveStartupDraftAgent(repo, args.createdWithAgent)
  if (!agent) {
    // Avoid repeating agent detection when the draft resolved no agent.
    const { startupDraft: _draft, ...withoutDraft } = args
    return { passthrough: withoutDraft }
  }
  return { agent, prompt: { text: args.startupDraft ?? '', delivery: 'draft' }, connectionId }
}

/** startupAgent would override the draft; keep its resolved agent separate from createdWithAgent. */
function legacyStartupFields(
  agent: TuiAgent,
  prompt: AgentLaunchPrompt | undefined
): Partial<RuntimeManagedWorktreeCreateArgs> {
  if (prompt?.delivery === 'draft') {
    return { startupDraftAgent: agent, startupDraft: prompt.text }
  }
  return {
    startupAgent: agent,
    ...(prompt ? { startupPrompt: prompt.text } : {})
  }
}

function withoutStartupAgentFields(
  args: RuntimeManagedWorktreeCreateArgs
): RuntimeManagedWorktreeCreateArgs {
  const {
    startupAgent: _agent,
    startupPrompt: _prompt,
    startupDraft: _draft,
    startupDraftAgent: _draftAgent,
    startupLaunchSource: _source,
    ...rest
  } = args
  return rest
}
