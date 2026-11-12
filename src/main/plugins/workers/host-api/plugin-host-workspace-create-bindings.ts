import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import { pluginWorkspaceId } from '../../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import {
  suggestCreatureNameForPaths,
  suggestionPathBasename
} from '../../../../shared/worktree-name-suggestion'
import { WorktreeCreateSetupChoiceRefusedError } from '../../../runtime/workspaces/creation/worktree-create-setup-choice-refusal'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'
import {
  pluginHostEffect as effect,
  pluginHostRpc as rpc,
  pluginRuntimeErrorIs,
  type PluginRuntimeRpc
} from './plugin-host-runtime-call'
import { resolvePluginProject, type PluginProjectTarget } from './plugin-host-project-target'
import { recordPluginOpenedTerminal } from './plugin-opened-terminals'
import { PLUGIN_AGENT_RESUME_HANDLERS } from './plugin-host-agent-resume-binding'

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
  worktrees: z.array(
    worktreeRecord.extend({
      repoId: z.string(),
      path: z.string(),
      displayName: z.string().optional(),
      hostId: z.string().optional()
    })
  )
})

const listedId = (worktree: z.output<typeof worktreeRecord>): string =>
  pluginWorkspaceId({ id: worktree.id, identityKey: worktree.identity?.key })

/** Every worktree of the project on its host; the list is not paged, so none is missed. */
async function projectWorktrees(call: PluginRuntimeRpc, project: PluginProjectTarget) {
  const { worktrees } = worktreeListAnswer.parse(
    await call('worktree.list', { limit: Number.MAX_SAFE_INTEGER })
  )
  return worktrees.filter(
    (worktree) =>
      worktree.repoId === project.id && (!project.hostId || worktree.hostId === project.hostId)
  )
}

const setupDecisionRequired = (): PluginHostCallError =>
  new PluginHostCallError(
    'action_failed',
    "this project's setup script needs a decision; pass setup: 'skip' or create it in Orca"
  )

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
    const existing = await projectWorktrees(call, project)
    const open = params.open === true
    // A creature no workspace of the project uses; a later clash gets a suffix from the host.
    const name = params.name?.trim() || suggestCreatureNameForPaths(existing.map((w) => w.path))
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
    // Told apart by the class the runtime threw, never by its wording.
    const setupRefusal = (error: unknown): unknown =>
      pluginRuntimeErrorIs(error, WorktreeCreateSetupChoiceRefusedError)
        ? setupDecisionRequired()
        : error
    if (!params.agent) {
      const { worktree } = worktreeCreateAnswer.parse(
        await effect(ctx, 'worktree.create', create).catch((error: unknown) => {
          throw setupRefusal(error)
        })
      )
      return { workspaceId: listedId(worktree) }
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
      }).catch(async (error: unknown) => {
        const refusal = setupRefusal(error)
        throw refusal === error
          ? await withCreatedWorkspace(call, project, existing, name, error)
          : refusal
      })
    )
    // The plugin may have lost approval while the agent started.
    ctx.scope.assertActive()
    recordPluginOpenedTerminal(ctx.pluginId, launched.outcome.handle)
    const { worktree } = worktreeShowAnswer.parse(
      await call('worktree.show', { worktree: `id:${launched.worktreeId}` })
    )
    return { workspaceId: listedId(worktree), terminalId: launched.outcome.handle }
  }),
  ...PLUGIN_AGENT_RESUME_HANDLERS
} satisfies Record<string, BoundPluginHostMethod>

/** Whether a worktree is the one a create named `name` makes: it shows that name, or its folder
 *  is that name, or that name with the `-N` Orca adds when the name is taken. */
function madeFromName(worktree: { path: string; displayName?: string }, name: string): boolean {
  const folder = suggestionPathBasename(worktree.path)
  const suffix = folder.startsWith(`${name}-`) ? folder.slice(name.length + 1) : ''
  return (
    worktree.displayName === name ||
    folder === name ||
    (suffix.length > 0 && [...suffix].every((char) => char >= '0' && char <= '9'))
  )
}

/**
 * A launch can fail after its worktree exists; the refusal then names that workspace, so the
 * plugin can use or remove it. Found as the one new worktree of the project with this name.
 */
async function withCreatedWorkspace(
  call: PluginRuntimeRpc,
  project: PluginProjectTarget,
  before: readonly { id: string }[],
  name: string,
  error: unknown
): Promise<unknown> {
  const known = new Set(before.map((worktree) => worktree.id))
  const created = await projectWorktrees(call, project).then(
    (after) => after.filter((worktree) => !known.has(worktree.id) && madeFromName(worktree, name)),
    () => []
  )
  if (created.length !== 1 || !(error instanceof PluginHostCallError)) {
    return error
  }
  return new PluginHostCallError(
    error.code,
    `${error.message}; the workspace was created: ${listedId(created[0])}`,
    error.retryAfterMs,
    error.detail,
    { cause: error }
  )
}
