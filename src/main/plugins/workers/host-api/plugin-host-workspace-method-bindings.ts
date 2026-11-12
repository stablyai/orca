import { z } from 'zod'
import { availableWorkspaceAgents } from './plugin-host-available-agents'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import { PLUGIN_TERMINAL_READ_MAX_LINES } from '../../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'
import { claimPluginReplacedActionRun } from '../../plugin-command-replacement-deadline'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  pluginHostEffect as effect,
  pluginHostRenderer as renderer,
  pluginHostRpc as rpc,
  pluginWorkspaceSelector as workspaceSelector
} from './plugin-host-runtime-call'
import { listPluginProjects, listPluginWorkspaces } from './plugin-host-workspace-list'
import { recordPluginOpenedTerminal } from './plugin-opened-terminals'

const api = PLUGIN_HOST_API
const DEFAULT_READ_LINES = 200

// The parts of each runtime answer a host method reads; anything else is dropped.
const folderUpdateAnswer = z.object({
  folderWorkspace: z.object({ name: z.string() }).nullable()
})
const worktreeSetAnswer = z.object({ worktree: z.object({ displayName: z.string() }) })
const terminalCreateAnswer = z.object({ terminal: z.object({ handle: z.string() }) })
const terminalReadAnswer = z.object({
  terminal: z.object({
    tail: z.array(z.string()),
    truncated: z.boolean().optional(),
    limited: z.boolean().optional()
  })
})
const agentLaunchAnswer = z.object({
  outcome: z.object({ kind: z.enum(['structured', 'terminal']), handle: z.string() }),
  prompt: z.object({ outcome: z.string() }).optional()
})

export const PLUGIN_WORKSPACE_ACTION_HANDLERS = {
  'agents.available': bind(api['agents.available'], async ({ workspaceId }, { services }) =>
    availableWorkspaceAgents(services, workspaceId)
  ),
  'workspace.list': bind(api['workspace.list'], async (params, { services }) =>
    listPluginWorkspaces(
      rpc(services),
      params?.includeStatus === true,
      services.runtimeRpc ?? services
    )
  ),
  'project.list': bind(api['project.list'], async (_params, { services }) =>
    listPluginProjects(rpc(services))
  ),
  'workspace.open': bind(api['workspace.open'], async ({ workspaceId }, ctx) => {
    const scope = parseWorkspaceKey(workspaceId)
    if (scope?.type === 'folder') {
      // The runtime activates Git worktrees only; Orca's window shows a folder workspace.
      ctx.scope.assertActive()
      await renderer(ctx.services).openFolderWorkspace(scope.folderWorkspaceId)
      return { opened: true as const }
    }
    await effect(ctx, 'worktree.activate', { worktree: workspaceSelector(workspaceId) })
    return { opened: true as const }
  }),
  'workspace.rename': bind(api['workspace.rename'], async ({ workspaceId, name }, ctx) => {
    const trimmed = name.trim()
    const scope = parseWorkspaceKey(workspaceId)
    // The same update as a rename in the sidebar: the name is pinned and a pending
    // automatic (first agent message) rename is cancelled, so neither replaces it later.
    const renamed =
      scope?.type === 'folder'
        ? folderUpdateAnswer.parse(
            await effect(ctx, 'folderWorkspace.update', {
              folderWorkspaceId: scope.folderWorkspaceId,
              // Twins on two hosts can share a folder id; refuse rather than rename both.
              requireUniqueId: true,
              updates: {
                name: trimmed,
                pendingFirstAgentMessageRename: false,
                firstAgentMessageRenameError: null
              }
            })
          ).folderWorkspace?.name
        : worktreeSetAnswer.parse(
            await effect(ctx, 'worktree.set', {
              worktree: workspaceSelector(workspaceId),
              displayName: trimmed
            })
          ).worktree.displayName
    if (renamed === undefined) {
      throw new PluginHostCallError('action_failed', 'no workspace has this id')
    }
    // Orca keeps the old name while the workspace is moving to or from WSL.
    if (renamed !== trimmed) {
      throw new PluginHostCallError('conflict', 'the workspace cannot be renamed right now')
    }
    return { name: trimmed }
  }),
  'terminal.create': bind(api['terminal.create'], async (params, ctx) => {
    const answer = await effect(ctx, 'terminal.create', {
      worktree: workspaceSelector(params.workspaceId),
      ...(params.title ? { title: params.title } : {}),
      ...(params.command ? { command: params.command } : {}),
      // A mod works beside the person: never reveal or focus the new terminal.
      presentation: 'background'
    })
    const terminalId = terminalCreateAnswer.parse(answer).terminal.handle
    // A plugin that lost approval, or a worker that cancelled, while the call ran gains no close
    // rights from it.
    ctx.scope.assertActive()
    if (!ctx.scope.signal?.aborted) {
      recordPluginOpenedTerminal(ctx.pluginId, terminalId)
    }
    return { terminalId }
  }),
  'terminal.read': bind(api['terminal.read'], async (params, { services, scope }) => {
    const limit = Math.min(params.maxLines ?? DEFAULT_READ_LINES, PLUGIN_TERMINAL_READ_MAX_LINES)
    const answer = await rpc(services)(
      'terminal.read',
      { terminal: params.terminalId, limit },
      scope.signal ? { signal: scope.signal } : {}
    )
    const { tail, truncated, limited } = terminalReadAnswer.parse(answer).terminal
    return {
      lines: tail.slice(-limit),
      // `limited`: the runtime itself kept only the newest lines.
      truncated: truncated === true || limited === true || tail.length > limit
    }
  }),
  'agent.launch': bind(api['agent.launch'], async (params, ctx) => {
    const worktree = workspaceSelector(params.workspaceId)
    const answer = await new Promise<unknown>((resolve, reject) => {
      let publishedHandle: string | undefined
      const launched = effect(
        ctx,
        'agent.launch',
        {
          target: { kind: 'existing', worktree },
          agent: params.agent,
          // A terminal, so `terminal.read` and `terminal.sendText` reach the returned handle.
          surface: 'terminal',
          presentation: 'background',
          launchSource: 'plugin',
          ...(params.prompt ? { prompt: { text: params.prompt, delivery: 'submit' } } : {})
        },
        {
          // Host calls return before the minute-long readiness wait; the fresh launch owns delivery.
          onAgentLaunchSurfacePublished: (surface) => {
            publishedHandle = agentLaunchAnswer.parse(surface).outcome.handle
            resolve(surface)
          }
        }
      )
      void launched.then(
        (result) => {
          resolve(result)
          const completed = agentLaunchAnswer.safeParse(result)
          const disposal = completed.success ? completed.data.prompt?.outcome : undefined
          if (disposal === 'not-delivered' || disposal === 'unconfirmed') {
            ctx.scope.log?.(`agent.launch: prompt delivery was ${disposal} for ${publishedHandle}`)
          }
        },
        (error: unknown) => {
          reject(error)
          if (publishedHandle) {
            ctx.scope.log?.(
              `agent.launch: the prompt did not reach ${publishedHandle}: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
      )
    })
    const terminalId = agentLaunchAnswer.parse(answer).outcome.handle
    // A plugin that lost approval, or a worker that cancelled, while the call ran gains no close
    // rights from it.
    ctx.scope.assertActive()
    if (!ctx.scope.signal?.aborted) {
      recordPluginOpenedTerminal(ctx.pluginId, terminalId)
    }
    return { terminalId }
  }),
  'editor.open': bind(api['editor.open'], async ({ workspaceId, path }, { services, scope }) => {
    scope.assertActive()
    await renderer(services).openFile(workspaceId, path)
    return { opened: true as const }
  }),
  'commands.run': bind(api['commands.run'], async ({ action }, { pluginId, services, scope }) => {
    scope.assertActive()
    claimPluginReplacedActionRun(pluginId, action)
    // Always Orca's own action, never a plugin command that replaces it: a replacement that
    // calls commands.run for the original would otherwise call itself.
    await renderer(services).runAction(action)
    return { ran: true as const }
  })
} satisfies Record<string, BoundPluginHostMethod>
