import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../shared/plugins/workers/plugin-host-api'
import {
  PLUGIN_TERMINAL_READ_MAX_LINES,
  PLUGIN_WORKSPACE_LIST_LIMIT
} from '../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import {
  bind,
  type BoundPluginHostMethod,
  type PluginHostMethodContext
} from './plugin-host-method-bind'
import type { PluginHostServices } from './plugin-host-method-bindings'
import { PluginHostCallError } from './plugin-host-call-scope'
import { claimPluginReplacedActionRun } from '../plugin-command-replacement-deadline'
import type { PluginHostRendererActions } from '../view/plugin-host-renderer-actions'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'

/** The runtime RPC the `orca` CLI calls, run in process; rejects with the runtime's error.
 *  `beforeEffect` runs right before the runtime acts, after its own waits; a throw refuses it. */
export type PluginRuntimeRpc = (
  method: string,
  params: unknown,
  options?: { signal?: AbortSignal; beforeEffect?: () => void }
) => Promise<unknown>

const api = PLUGIN_HOST_API
const DEFAULT_READ_LINES = 200

// The parts of each runtime answer a host method reads; anything else is dropped.
const worktreeListAnswer = z.object({
  worktrees: z.array(
    z.object({
      id: z.string(),
      repoId: z.string(),
      displayName: z.string(),
      path: z.string(),
      branch: z.string().optional(),
      hostId: z.string().optional(),
      identity: z.object({ key: z.string() }).optional()
    })
  ),
  totalCount: z.number().optional(),
  truncated: z.boolean().optional()
})
const repoListAnswer = z.object({
  repos: z.array(z.object({ id: z.string(), kind: z.string().optional() }))
})
const folderListAnswer = z.object({
  folderWorkspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      folderPath: z.string(),
      executionHostId: z.string().nullable().optional()
    })
  )
})
const terminalCreateAnswer = z.object({ terminal: z.object({ handle: z.string() }) })
const terminalReadAnswer = z.object({
  terminal: z.object({
    tail: z.array(z.string()),
    truncated: z.boolean().optional(),
    limited: z.boolean().optional()
  })
})
const agentLaunchAnswer = z.object({
  outcome: z.object({ kind: z.enum(['structured', 'terminal']), handle: z.string() })
})

function renderer(services: PluginHostServices): PluginHostRendererActions {
  if (!services.renderer) {
    throw new PluginHostCallError('unavailable', 'only the Orca desktop app can do this')
  }
  return services.renderer
}

function rpc(services: PluginHostServices): PluginRuntimeRpc {
  if (!services.runtimeRpc) {
    throw new PluginHostCallError('unavailable', 'this Orca host cannot run workspace actions')
  }
  return services.runtimeRpc
}

/** A runtime call that changes something: refused if the plugin lost approval, or its worker
 *  cancelled the call, at any point before the runtime acts. */
function effect(ctx: PluginHostMethodContext, method: string, params: unknown): Promise<unknown> {
  ctx.scope.assertActive()
  return rpc(ctx.services)(method, params, {
    ...(ctx.scope.signal ? { signal: ctx.scope.signal } : {}),
    beforeEffect: () => ctx.scope.assertActive()
  })
}

/**
 * The selector a listed workspace id names. Ids carry their host (`identity:`, unique across
 * twins on two hosts) or are folder keys; a bare id from elsewhere is taken as an exact id.
 */
function workspaceSelector(workspaceId: string): string {
  return workspaceId.startsWith('identity:') ? workspaceId : `id:${workspaceId}`
}

/** `refs/heads/main` reads as `main`; a detached or folder workspace has none. */
function branchName(branch: string | undefined): string | null {
  const name = branch?.replace(/^refs\/heads\//, '') ?? ''
  return name || null
}

export const PLUGIN_WORKSPACE_ACTION_HANDLERS = {
  'workspace.list': bind(api['workspace.list'], async (_params, { services }) => {
    const call = rpc(services)
    const [listed, repos, folderList] = await Promise.all([
      call('worktree.list', { limit: PLUGIN_WORKSPACE_LIST_LIMIT }),
      call('repo.list', {}),
      call('folderWorkspace.list', undefined)
    ])
    const { worktrees, totalCount, truncated } = worktreeListAnswer.parse(listed)
    const folderRepos = new Set(
      repoListAnswer
        .parse(repos)
        .repos.filter((repo) => repo.kind === 'folder')
        .map((repo) => repo.id)
    )
    const worktreeRows = worktrees.slice(0, PLUGIN_WORKSPACE_LIST_LIMIT).map((worktree) => {
      const folder = folderRepos.has(worktree.repoId)
      return {
        id: worktree.identity ? `identity:${worktree.identity.key}` : worktree.id,
        kind: folder ? ('folder' as const) : ('worktree' as const),
        name: worktree.displayName,
        path: worktree.path,
        branch: folder ? null : branchName(worktree.branch),
        hostId: worktree.hostId ?? null
      }
    })
    // Project-group folders have no repo row; their key is what selectors take.
    const projectFolders = folderListAnswer.parse(folderList).folderWorkspaces.map((folder) => ({
      id: folderWorkspaceKey(folder.id),
      kind: 'folder' as const,
      name: folder.name,
      path: folder.folderPath,
      branch: null,
      hostId: folder.executionHostId ?? null
    }))
    const room = PLUGIN_WORKSPACE_LIST_LIMIT - worktreeRows.length
    return {
      workspaces: [...worktreeRows, ...projectFolders.slice(0, room)],
      truncated:
        truncated === true ||
        (totalCount ?? worktrees.length) > worktreeRows.length ||
        projectFolders.length > room
    }
  }),
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
  'terminal.create': bind(api['terminal.create'], async (params, ctx) => {
    const answer = await effect(ctx, 'terminal.create', {
      worktree: workspaceSelector(params.workspaceId),
      ...(params.title ? { title: params.title } : {}),
      ...(params.command ? { command: params.command } : {}),
      // A mod works beside the person: never reveal or focus the new terminal.
      presentation: 'background'
    })
    return { terminalId: terminalCreateAnswer.parse(answer).terminal.handle }
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
    const answer = await effect(ctx, 'agent.launch', {
      target: { kind: 'existing', worktree },
      agent: params.agent,
      // A terminal, so `terminal.read` and `terminal.sendText` reach the agent the call returns.
      surface: 'terminal',
      // A mod works beside the person: never take their focus.
      presentation: 'background',
      launchSource: 'plugin'
    })
    const terminalId = agentLaunchAnswer.parse(answer).outcome.handle
    if (params.prompt) {
      // Delivery waits for the agent's composer (up to a minute), longer than a host call may take.
      void effect(ctx, 'agent.launch', {
        target: { kind: 'existing', worktree },
        agent: params.agent,
        reuseTerminal: { handle: terminalId },
        prompt: { text: params.prompt, delivery: 'submit' },
        presentation: 'background',
        launchSource: 'plugin'
      }).catch((error: unknown) => {
        ctx.scope.log?.(
          `agent.launch: the prompt did not reach ${terminalId}: ${error instanceof Error ? error.message : String(error)}`
        )
      })
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
