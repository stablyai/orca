/**
 * Creating a workspace with its agent the way `worktree.create` always has, through the executor.
 *
 * The agent is the workspace's startup terminal, never a chat, and the create delivers the text
 * itself; that is `worktree.create`'s contract, so the launch is `terminalOnly` with the
 * `legacy-host` prompt policy. Request and result are the create's own, so a caller swaps
 * `runtime.createManagedWorktree` for this and nothing a client sends or reads changes.
 *
 * This is the one `legacy-host` producer, so the no-agent outcome below is caught in one place.
 * The host's other agent-first creates (headless automations, federation) still call
 * `createManagedWorktree` directly; they are to call this entry, not the executor.
 */

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
        // Reads the typed request it was built from; the executor's `create` is the same minus the
        // agent fields, which come back as arguments here.
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
    // A workspace with no agent back is the answer `worktree.create` has always given here.
    if (!(error instanceof AgentLaunchStartupAgentNotCreatedError) || !created) {
      throw error
    }
  }
  if (!created) {
    throw new Error('agent_launch_workspace_not_created')
  }
  return created
}

/** The launch a create asks for, or the create to run as is when it starts no agent. Mirrors the
 *  create's own order: a prebuilt command wins, then `startupAgent`, then a linked draft's agent. */
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
      // A blank prompt is no prompt: the create launches the agent bare for it, sending nothing.
      prompt: args.startupPrompt?.trim()
        ? { text: args.startupPrompt, delivery: 'submit' }
        : undefined,
      connectionId
    }
  }
  const agent = await runtime.resolveStartupDraftAgent(repo, args.createdWithAgent)
  if (!agent) {
    // The draft starts no agent, and the create would only run detection again to learn that.
    const { startupDraft: _draft, ...withoutDraft } = args
    return { passthrough: withoutDraft }
  }
  return { agent, prompt: { text: args.startupDraft ?? '', delivery: 'draft' }, connectionId }
}

/** A draft starts its agent through `startupDraft`, which a `startupAgent` would override. The
 *  chosen agent rides `startupDraftAgent` so the create neither chooses again nor records it as
 *  the agent the caller asked for: `createdWithAgent` stays the request's. */
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
