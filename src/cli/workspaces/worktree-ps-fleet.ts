// `orca worktree ps --since`: this computer's workspaces and every paired server's, in one list, each
// row naming the bot it is under even when that bot lives here and the workspace on a server (its
// parent on another machine, joined by each host's own installationId).
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import type { RuntimeWorktreePsResult } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import { nameBotOwners } from '../../shared/bots/bot-workspace-owner'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { getDefaultUserDataPath } from '../runtime/profile/metadata'
import { RuntimeClient } from '../runtime/client'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { WithAnnotatedHostScope } from '../hosts/omitted-host-scope-selectors'

const SERVER_TIMEOUT_MS = 15_000

type PsParams = { limit?: number; includeAgentWait?: true }

async function serverRows(
  hostId: ExecutionHostId,
  params: PsParams
): Promise<RuntimeWorktreePsResult | null> {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    return null
  }
  const known = (await listEnvironments(getDefaultUserDataPath())).find(
    (environment) => environment.id === host.environmentId
  )
  if (!known) {
    return null
  }
  const server = new RuntimeClient(undefined, SERVER_TIMEOUT_MS, null, known.id)
  // An unreachable server stays listed as not covered.
  const reply = await server.call<RuntimeWorktreePsResult>('worktree.ps', params).catch(() => null)
  if (!reply) {
    return null
  }
  // A server names its own rows local; here they are that server's.
  return {
    ...reply.result,
    worktrees: reply.result.worktrees.map((row) => ({ ...row, hostId }))
  }
}

/** The local list plus each paired server it leaves out; servers that can't answer stay uncovered. */
export async function readWorktreePsAcrossServers(
  client: RuntimeClient,
  params: PsParams
): Promise<RuntimeRpcSuccess<WithAnnotatedHostScope<RuntimeWorktreePsResult>>> {
  const local = await client.call<WithAnnotatedHostScope<RuntimeWorktreePsResult>>(
    'worktree.ps',
    params
  )
  const result = local.result
  const omitted = result.hostScope?.omittedHostIds ?? []
  const servers = await Promise.all(
    omitted.map(async (hostId) => ({ hostId, rows: await serverRows(hostId, params) }))
  )
  const reached = servers.flatMap((server) => {
    const host = parseExecutionHostId(server.hostId)
    return server.rows && host?.kind === 'runtime'
      ? [{ hostId: server.hostId, environmentId: host.environmentId, rows: server.rows }]
      : []
  })
  const merged = {
    ...result,
    worktrees: nameBotOwners([
      { rows: result.worktrees, installationId: result.installationId },
      ...reached.map((server) => ({
        rows: server.rows.worktrees,
        environmentId: server.environmentId,
        installationId: server.rows.installationId
      }))
    ]),
    totalCount:
      result.totalCount + reached.reduce((sum, server) => sum + server.rows.totalCount, 0),
    truncated: result.truncated || reached.some((server) => server.rows.truncated),
    ...(result.hostScope
      ? {
          hostScope: {
            hostIds: [...result.hostScope.hostIds, ...reached.map((server) => server.hostId)],
            omittedHostIds: omitted.filter(
              (hostId) => !reached.some((server) => server.hostId === hostId)
            )
          }
        }
      : {})
  }
  return { ...local, result: merged }
}
