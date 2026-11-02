import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../shared/plugins/workers/plugin-host-api'
import {
  PLUGIN_TERMINAL_READ_MAX_LINES,
  PLUGIN_WORKSPACE_LIST_LIMIT
} from '../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import type { PluginHostServices } from './plugin-host-method-bindings'

/** The runtime RPC the `orca` CLI calls, run in process; rejects with the runtime's error. */
export type PluginRuntimeRpc = (method: string, params: unknown) => Promise<unknown>

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
      hostId: z.string().optional()
    })
  ),
  totalCount: z.number().optional(),
  truncated: z.boolean().optional()
})
const repoListAnswer = z.object({
  repos: z.array(z.object({ id: z.string(), kind: z.string().optional() }))
})
const terminalCreateAnswer = z.object({ terminal: z.object({ handle: z.string() }) })
const terminalReadAnswer = z.object({
  terminal: z.object({ tail: z.array(z.string()), truncated: z.boolean().optional() })
})
const agentLaunchAnswer = z.object({
  outcome: z.object({ kind: z.enum(['structured', 'terminal']), handle: z.string() })
})

function rpc(services: PluginHostServices): PluginRuntimeRpc {
  if (!services.runtimeRpc) {
    throw new Error('this Orca host cannot run workspace actions for plugins')
  }
  return services.runtimeRpc
}

const worktreeSelector = (workspaceId: string): string => `id:${workspaceId}`

/** `refs/heads/main` reads as `main`; a detached or folder workspace has none. */
function branchName(branch: string | undefined): string | null {
  const name = branch?.replace(/^refs\/heads\//, '') ?? ''
  return name || null
}

export const PLUGIN_WORKSPACE_ACTION_HANDLERS = {
  'workspace.list': bind(api['workspace.list'], async (_params, { services }) => {
    const call = rpc(services)
    const [listed, repos] = await Promise.all([
      call('worktree.list', { limit: PLUGIN_WORKSPACE_LIST_LIMIT }),
      call('repo.list', {})
    ])
    const { worktrees, totalCount, truncated } = worktreeListAnswer.parse(listed)
    const folders = new Set(
      repoListAnswer
        .parse(repos)
        .repos.filter((repo) => repo.kind === 'folder')
        .map((repo) => repo.id)
    )
    const shown = worktrees.slice(0, PLUGIN_WORKSPACE_LIST_LIMIT)
    return {
      workspaces: shown.map((worktree) => {
        const folder = folders.has(worktree.repoId)
        return {
          id: worktree.id,
          kind: folder ? ('folder' as const) : ('worktree' as const),
          name: worktree.displayName,
          path: worktree.path,
          branch: folder ? null : branchName(worktree.branch),
          hostId: worktree.hostId ?? null
        }
      }),
      truncated: truncated === true || (totalCount ?? shown.length) > shown.length
    }
  }),
  'workspace.open': bind(api['workspace.open'], async ({ workspaceId }, { services, scope }) => {
    scope.assertActive()
    await rpc(services)('worktree.activate', { worktree: worktreeSelector(workspaceId) })
    return { opened: true as const }
  }),
  'terminal.create': bind(api['terminal.create'], async (params, { services, scope }) => {
    scope.assertActive()
    const answer = await rpc(services)('terminal.create', {
      worktree: worktreeSelector(params.workspaceId),
      ...(params.title ? { title: params.title } : {}),
      ...(params.command ? { command: params.command } : {})
    })
    return { terminalId: terminalCreateAnswer.parse(answer).terminal.handle }
  }),
  'terminal.read': bind(api['terminal.read'], async (params, { services }) => {
    const limit = Math.min(params.maxLines ?? DEFAULT_READ_LINES, PLUGIN_TERMINAL_READ_MAX_LINES)
    const answer = await rpc(services)('terminal.read', { terminal: params.terminalId, limit })
    const { tail, truncated } = terminalReadAnswer.parse(answer).terminal
    return { lines: tail.slice(-limit), truncated: truncated === true || tail.length > limit }
  }),
  'agent.launch': bind(api['agent.launch'], async (params, { services, scope }) => {
    scope.assertActive()
    const answer = await rpc(services)('agent.launch', {
      target: { kind: 'existing', worktree: worktreeSelector(params.workspaceId) },
      agent: params.agent,
      ...(params.prompt ? { prompt: { text: params.prompt, delivery: 'submit' } } : {}),
      // A mod works beside the person: never take their focus.
      presentation: 'background',
      launchSource: 'plugin'
    })
    const { outcome } = agentLaunchAnswer.parse(answer)
    return {
      terminalId: outcome.handle,
      surface: outcome.kind === 'structured' ? ('chat' as const) : ('terminal' as const)
    }
  })
} satisfies Record<string, BoundPluginHostMethod>
