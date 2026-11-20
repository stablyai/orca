import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import { PLUGIN_HOST_LIST_LIMIT } from '../../../../shared/plugins/workers/plugin-host-api-hosts'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import {
  bind,
  type BoundPluginHostMethod,
  type PluginHostMethodContext
} from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'
import {
  pluginHostEffect as effect,
  pluginHostRpc as rpc,
  pluginRuntimeFailure
} from './plugin-host-runtime-call'

const PROJECT_ADD_TIMEOUT_MS = 30_000

const targetSummariesAnswer = z.object({
  targets: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      connected: z.boolean().optional(),
      managedServer: z.literal(true).optional()
    })
  )
})
const addTargetAnswer = z.object({ target: z.object({ id: z.string().min(1) }) })
const sshStateAnswer = z.object({
  state: z
    .object({
      status: z.string(),
      managedServer: z.object({ kind: z.string(), environmentId: z.string().optional() }).optional()
    })
    .nullable()
})
const repoAddAnswer = z.object({ repo: z.object({ id: z.string().min(1) }) })
const repoListAnswer = z.object({ repos: z.array(z.object({ id: z.string() })) })

/** The SSH target an `ssh:` host names; other hosts are refused with a fixed message. */
function sshTargetIdOf(hostId: string): string {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind !== 'ssh') {
    throw new PluginHostCallError(
      'invalid_params',
      'hostId: pass an ssh: host that host.list gives'
    )
  }
  return parsed.targetId
}

/** The Orca server a connected SSH host runs; refused while it is not connected or has none. */
async function connectedSshEnvironment(
  ctx: PluginHostMethodContext,
  targetId: string
): Promise<string> {
  const { state } = sshStateAnswer.parse(await rpc(ctx.services)('ssh.getState', { targetId }))
  if (state?.status !== 'connected') {
    throw new PluginHostCallError(
      'action_failed',
      'this host is not connected; connect it with host.connect first'
    )
  }
  const server = state.managedServer
  if (server?.kind !== 'managed' || !server.environmentId) {
    throw new PluginHostCallError(
      'action_failed',
      "this host is not running Orca's server yet; reconnect it with host.connect"
    )
  }
  return server.environmentId
}

/** A runtime RPC on a paired Orca server, refused as a plugin sees runtime refusals. */
async function environmentEffect(
  ctx: PluginHostMethodContext,
  environmentId: string,
  method: string,
  params: unknown
): Promise<unknown> {
  const call = ctx.services.environmentRpc
  if (!call) {
    throw new PluginHostCallError('unavailable', 'this Orca host cannot reach SSH hosts')
  }
  ctx.scope.assertActive()
  const response = await call(environmentId, method, params, {
    timeoutMs: PROJECT_ADD_TIMEOUT_MS,
    ...(ctx.scope.signal ? { signal: ctx.scope.signal } : {})
  }).catch((error: unknown) => {
    throw pluginRuntimeFailure(error)
  })
  if (!response.ok) {
    throw pluginRuntimeFailure(Object.assign(new Error(response.error.message), response.error))
  }
  return response.result
}

export const PLUGIN_HOSTS_HANDLERS = {
  'host.list': bind(PLUGIN_HOST_API['host.list'], async (_params, ctx) => {
    const { targets } = targetSummariesAnswer.parse(
      await rpc(ctx.services)('ssh.listTargetSummaries', {})
    )
    const rows = targets.map((target) => ({
      hostId: toSshExecutionHostId(target.id),
      kind: 'ssh' as const,
      name: target.label.slice(0, 200),
      connected: target.connected === true
    }))
    const local = {
      hostId: LOCAL_EXECUTION_HOST_ID,
      kind: 'local' as const,
      name: 'This computer',
      connected: true
    }
    const hosts = [local, ...rows].slice(0, PLUGIN_HOST_LIST_LIMIT)
    return { hosts, truncated: rows.length + 1 > hosts.length }
  }),

  'host.addSshTarget': bind(PLUGIN_HOST_API['host.addSshTarget'], async (params, ctx) => {
    const { target } = addTargetAnswer.parse(
      await effect(ctx, 'ssh.addTarget', {
        target: {
          label: params.name,
          // An alias resolves through ssh_config only when Orca also sees it as configHost.
          configHost: params.host,
          host: params.host,
          port: params.port ?? 22,
          username: params.username ?? '',
          ...(params.proxyCommand ? { proxyCommand: params.proxyCommand } : {}),
          ...(params.identityFile ? { identityFile: params.identityFile } : {})
        }
      })
    )
    return { hostId: toSshExecutionHostId(target.id) }
  }),

  'host.connect': bind(PLUGIN_HOST_API['host.connect'], async (params, ctx) => {
    const targetId = sshTargetIdOf(params.hostId)
    const { state } = sshStateAnswer.parse(await effect(ctx, 'ssh.connect', { targetId }))
    return { connected: state?.status === 'connected' }
  }),

  'project.add': bind(PLUGIN_HOST_API['project.add'], async (params, ctx) => {
    const add = {
      path: params.path,
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.name ? { displayName: params.name } : {})
    }
    const hostId = params.hostId ?? LOCAL_EXECUTION_HOST_ID
    if (hostId === LOCAL_EXECUTION_HOST_ID) {
      const known = repoListAnswer.parse(await rpc(ctx.services)('repo.list', {})).repos
      const { repo } = repoAddAnswer.parse(await effect(ctx, 'repo.add', add))
      return {
        projectId: repo.id,
        hostId: LOCAL_EXECUTION_HOST_ID,
        created: !known.some((entry) => entry.id === repo.id)
      }
    }
    // Projects on an SSH host live on the Orca server Orca runs there, as Add Project does.
    const environmentId = await connectedSshEnvironment(ctx, sshTargetIdOf(hostId))
    const known = repoListAnswer.parse(
      await environmentEffect(ctx, environmentId, 'repo.list', {})
    ).repos
    const { repo } = repoAddAnswer.parse(
      await environmentEffect(ctx, environmentId, 'repo.add', add)
    )
    return {
      projectId: repo.id,
      hostId: toRuntimeExecutionHostId(environmentId),
      created: !known.some((entry) => entry.id === repo.id)
    }
  })
} satisfies Record<string, BoundPluginHostMethod>
