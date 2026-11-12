import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import {
  PLUGIN_WORKSPACE_LIST_LIMIT,
  pluginWorkspaceId
} from '../../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import { pluginResumeKey } from '../../../../shared/plugins/workers/plugin-agent-resume-key'
import { suggestCreatureNameForPaths } from '../../../../shared/worktree-name-suggestion'
import { ProviderSession } from '../../../../shared/rpc-contract/agent-session-params'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'
import {
  pluginHostEffect as effect,
  pluginHostRpc as rpc,
  pluginWorkspaceSelector as workspaceSelector,
  type PluginRuntimeRpc
} from './plugin-host-runtime-call'
import { resolvePluginProject } from './plugin-host-project-target'

const api = PLUGIN_HOST_API

// The parts of each runtime answer these methods read; anything else is dropped.
const worktreeRecord = z.object({
  id: z.string(),
  identity: z.object({ key: z.string() }).optional()
})
const worktreeCreateAnswer = z.object({ worktree: worktreeRecord })
const worktreeShowAnswer = z.object({ worktree: worktreeRecord })
const agentLaunchAnswer = z.object({
  worktreeId: z.string(),
  outcome: z.object({ handle: z.string() })
})
const worktreeListAnswer = z.object({
  worktrees: z.array(z.object({ repoId: z.string(), path: z.string() }))
})
const ensureSessionAnswer = z.object({
  terminal: z.object({ handle: z.string() }),
  disposition: z.enum(['created', 'adopted'])
})

/** A name Orca would pick in its own create dialog: a creature no workspace of the project uses. */
async function generatedName(call: PluginRuntimeRpc, projectId: string): Promise<string> {
  const { worktrees } = worktreeListAnswer.parse(
    await call('worktree.list', { limit: PLUGIN_WORKSPACE_LIST_LIMIT })
  )
  return suggestCreatureNameForPaths(
    worktrees.filter((worktree) => worktree.repoId === projectId).map((worktree) => worktree.path)
  )
}

export const PLUGIN_WORKSPACE_CREATE_HANDLERS = {
  'workspace.create': bind(api['workspace.create'], async (params, ctx) => {
    const call = rpc(ctx.services)
    const project = await resolvePluginProject(
      call,
      params.projectId,
      params.hostId,
      'pass the hostId project.list gives'
    )
    if (project.kind === 'folder') {
      throw new PluginHostCallError('action_failed', 'folder projects have no worktrees')
    }
    const open = params.open === true
    const name = params.name?.trim() || (await generatedName(call, project.id))
    // Never `run`, an approved setup hash or a startup command: those approve or run repository
    // code the person has not. Absent, setup follows the project's settings and approvals.
    const create = {
      repo: `id:${project.id}`,
      ...(project.hostId ? { repoHostId: project.hostId } : {}),
      name,
      ...(params.name
        ? { displayName: name, displayNameKind: 'user' }
        : { nameWasGenerated: true, displayNameKind: 'generated' }),
      ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
      setupDecision: params.setup === 'skip' ? 'skip' : 'inherit',
      activate: open,
      // A plugin moves this window only: paired clients are not steered.
      ...(open ? { navigation: 'host' } : {})
    }
    if (!params.agent) {
      const { worktree } = worktreeCreateAnswer.parse(await effect(ctx, 'worktree.create', create))
      return {
        workspaceId: pluginWorkspaceId({ id: worktree.id, identityKey: worktree.identity?.key })
      }
    }
    // The agent starts after setup, in the terminal setup ran in, as `orca worktree create
    // --agent` does; the prompt rides its launch.
    const launched = agentLaunchAnswer.parse(
      await effect(ctx, 'agent.launch', {
        target: { kind: 'create-worktree', create },
        agent: params.agent,
        surface: 'terminal',
        presentation: open ? 'focused' : 'background',
        launchSource: 'plugin',
        ...(params.prompt ? { prompt: { text: params.prompt, delivery: 'submit' } } : {})
      })
    )
    const { worktree } = worktreeShowAnswer.parse(
      await call('worktree.show', { worktree: `id:${launched.worktreeId}` })
    )
    return {
      workspaceId: pluginWorkspaceId({ id: worktree.id, identityKey: worktree.identity?.key }),
      terminalId: launched.outcome.handle
    }
  }),
  'agent.resume': bind(api['agent.resume'], async ({ workspaceId, agent, sessionId }, ctx) => {
    const key = pluginResumeKey(agent)
    if (!key) {
      throw new PluginHostCallError('invalid_params', 'this agent cannot resume by session id')
    }
    // A live row of the same session knows its transcript, which some agents resume from.
    const transcript = ProviderSession.shape.transcriptPath.safeParse(
      ctx.services
        .listAgentStatuses()
        .find((row) => row.agentType === agent && row.providerSession?.id === sessionId)
        ?.providerSession?.transcriptPath
    )
    const transcriptPath = transcript.success ? transcript.data : undefined
    const answer = ensureSessionAnswer.parse(
      await effect(ctx, 'terminal.ensureAgentSession', {
        kind: 'explicit',
        worktree: workspaceSelector(workspaceId),
        agent,
        providerSession: { key, id: sessionId, ...(transcriptPath ? { transcriptPath } : {}) },
        // A mod works beside the person: never take their focus.
        presentation: 'background'
      })
    )
    return { terminalId: answer.terminal.handle, started: answer.disposition === 'created' }
  })
} satisfies Record<string, BoundPluginHostMethod>
