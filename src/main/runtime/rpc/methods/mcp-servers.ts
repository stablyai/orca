// mcpServers.*: the host's own MCP server list, for any of the user's clients. Every method refuses
// while the host's switch is off; every change tells the other clients to re-read.
import { join } from 'node:path'
import type { McpServer } from '../../../../shared/mcp-servers/mcp-servers'
import {
  McpServerAdd,
  McpServerAgentFilesAllow,
  McpServerConnect,
  McpServerDiscover,
  McpServerImport,
  McpServerMove,
  McpServerProblems,
  McpServerProblemsCancel,
  McpServerSessions,
  McpServerSetAgentEnabled,
  McpServerSetSharedProcess,
  McpServerSetWorkspaces,
  McpServerTarget,
  McpServerUpdate,
  McpServersList
} from '../../../../shared/rpc-contract/mcp-servers-params'
import { botToolProblems } from '../../../bots/bot-tools-host'
import { botToolsEpoch } from '../../../bots/bot-tools-revision'
import {
  cancelHostListHealthChecks,
  joinHostListHealthCheck
} from '../../../mcp-servers/mcp-host-list-health-checks'
import { resolveBotToolInput } from '../../../bots/bot-tool-details'
import { MCP_HOST_LIST_RELAY_OWNER } from '../../../bots/tool-relay/bot-tool-relay'
import {
  readMcpHostList,
  setMcpAgentFileAllowed,
  mcpServerDetails,
  mcpServerIdsByName,
  removeMcpServer,
  setMcpServerAgentEnabled,
  setMcpServerSharedProcess,
  setMcpServerWorkspaces,
  updateMcpServer
} from '../../../mcp-servers/mcp-host-list'
import { addMcpServers } from '../../../mcp-servers/mcp-host-list-add'
import { assertMcpServersFeatureEnabled } from '../../../mcp-servers/mcp-servers-feature'
import { mcpHostListFolder } from '../../../mcp-servers/mcp-host-list-folder'
import { withMcpAgentProblems } from '../../../mcp-servers/mcp-agent-problems'
import { mcpServerConnection } from '../../../mcp-servers/mcp-server-connection'
import { rpcCallerOperationKey } from '../callers/rpc-caller-identity'
import { sharedMcpProcesses } from '../../../mcp-servers/shared-process/shared-mcp-processes'
import { defineMethod, type RpcContext } from '../core'
import { toolsHomeFor } from './bots-tools'
import { mcpServersOfPaste } from '../../../mcp-servers/mcp-server-paste'
import {
  agentMcpImportHost,
  copyAgentMcpServer,
  importAgentMcpServer,
  listAgentMcpServers,
  moveAgentMcpServer
} from './mcp-servers-import'

/** The list's last epoch told to clients: concurrent calls that see the same write tell them once. */
let announcedEpoch: number | null = null

/**
 * Runs `work` with the switch on. A change (`true`) also tells every other client to re-read the
 * list; `'written'` does only when the list was written since the call began and no other call has
 * told them of that write yet, so work that wrote and then failed still tells them.
 */
export async function onHost<T>(
  context: RpcContext,
  work: () => Promise<T>,
  changes: boolean | 'written' = false
): Promise<T> {
  assertMcpServersFeatureEnabled()
  const folder = mcpHostListFolder()
  const epoch = botToolsEpoch(folder)
  let done = false
  try {
    const result = await work()
    done = true
    return result
  } finally {
    const now = botToolsEpoch(folder)
    const written = now !== epoch && now !== announcedEpoch
    if (changes === 'written' ? written : changes && done) {
      announcedEpoch = now
      context.runtime.notifyMcpServersChanged()
      // A shared server removed, unshared or edited stops now, not on its next request.
      void sharedMcpProcesses.reconcile(folder).catch(() => {})
    }
  }
}

export const changed = (server: McpServer) => ({ server })

/** The asking window or connection, and the request it names, if any: cancelling with one drops
 *  only that request, so trays and Settings in one window don't end each other's checks. */
function problemsClient(context: RpcContext, requestId?: string): string {
  const client =
    context.connectionId ??
    (context.caller ? rpcCallerOperationKey(context.caller) : 'unidentified')
  return requestId ? `${client}\0${requestId}` : client
}

export const MCP_SERVER_METHODS = [
  defineMethod({
    name: 'mcpServers.list',
    permission: 'workspace',
    params: McpServersList,
    handler: (_params, context) =>
      onHost(context, async () => withMcpAgentProblems(await readMcpHostList()))
  }),
  defineMethod({
    name: 'mcpServers.add',
    permission: 'workspace',
    params: McpServerAdd,
    handler: (params, context) =>
      onHost(
        context,
        async () => {
          const given =
            'config' in params
              ? [resolveBotToolInput(params.config)]
              : mcpServersOfPaste(params.source, params.name)
          // A name the user gave is refused when taken; a paste's own names move to a free one.
          const nameGiven = 'config' in params || (params.name !== undefined && given.length === 1)
          const servers = await addMcpServers(given, {
            nameGiven,
            signal: context.signal,
            workspaces: params.workspaces
          })
          return { ...changed(servers[0]), servers }
        },
        'written'
      )
  }),
  defineMethod({
    name: 'mcpServers.details',
    permission: 'workspace',
    params: McpServerTarget,
    handler: (params, context) => onHost(context, () => mcpServerDetails(params.id))
  }),
  defineMethod({
    name: 'mcpServers.update',
    permission: 'workspace',
    params: McpServerUpdate,
    handler: (params, context) =>
      onHost(
        context,
        async () =>
          changed(
            await updateMcpServer(params.id, params.version, params.config, {
              signal: context.signal
            })
          ),
        'written'
      )
  }),
  defineMethod({
    name: 'mcpServers.remove',
    permission: 'workspace',
    params: McpServerTarget,
    handler: (params, context) =>
      onHost(
        context,
        async () => {
          await removeMcpServer(params.id)
          return { removed: params.id }
        },
        'written'
      )
  }),
  defineMethod({
    name: 'mcpServers.problems',
    permission: 'workspace',
    params: McpServerProblems,
    handler: (params, context) =>
      onHost(context, async () => {
        const agent = params.agent ?? 'claude'
        const remote = params.scope === 'remote'
        const folder = mcpHostListFolder()
        // A chat's tray checks only its own servers, so it starts none it doesn't list.
        const only = params.ids ? new Set(params.ids) : null
        // The bots' check, run by that agent's CLI over the host's list: one per agent, scope and list
        // write (epoch) at a time, so a request after an edit never joins a check of the old list. Read
        // without waiting, so the request joins before a cancel sent right after it can arrive.
        // Ids come from the checked run's own read, so a request that joins it gets that run's.
        const problems = await joinHostListHealthCheck(
          `${agent}\0${remote ? 'remote' : 'all'}\0${only ? [...only].sort().join(',') : '*'}\0${botToolsEpoch(folder)}`,
          problemsClient(context, params.requestId),
          context.signal,
          async (signal) => {
            const ids = await mcpServerIdsByName(folder)
            const names = only
              ? new Set([...ids].flatMap(([name, id]) => (only.has(id) ? [name] : [])))
              : undefined
            const home = await toolsHomeFor(context.runtime, agent, {
              botId: MCP_HOST_LIST_RELAY_OWNER,
              folder,
              signInFolder: join(folder, '.orca', 'sign-in'),
              otherBotFolders: []
            })
            const byName = await botToolProblems(home, { remote, signal, only: names })
            return Object.fromEntries(
              Object.entries(byName).flatMap(([name, problem]) => {
                const id = ids.get(name)
                return id ? [[id, problem] as const] : []
              })
            )
          }
        )
        return { problems }
      })
  }),
  defineMethod({
    // The asking window let go; the check's CLI and servers close once no other client waits on it.
    name: 'mcpServers.cancelProblems',
    permission: 'workspace',
    params: McpServerProblemsCancel,
    handler: (params, context) =>
      onHost(context, async () => {
        cancelHostListHealthChecks(problemsClient(context, params.requestId))
        return { cancelled: true }
      })
  }),
  defineMethod({
    name: 'mcpServers.setAgentEnabled',
    permission: 'workspace',
    params: McpServerSetAgentEnabled,
    handler: (params, context) =>
      onHost(
        context,
        async () =>
          changed(await setMcpServerAgentEnabled(params.id, params.agent, params.enabled)),
        'written'
      )
  }),
  defineMethod({
    name: 'mcpServers.setWorkspaces',
    permission: 'workspace',
    params: McpServerSetWorkspaces,
    handler: (params, context) =>
      onHost(
        context,
        async () =>
          changed(
            await setMcpServerWorkspaces(params.id, params.workspaces, { base: params.base })
          ),
        'written'
      )
  }),
  defineMethod({
    name: 'mcpServers.setSharedProcess',
    permission: 'workspace',
    params: McpServerSetSharedProcess,
    handler: (params, context) =>
      onHost(
        context,
        async () => changed(await setMcpServerSharedProcess(params.id, params.enabled)),
        'written'
      )
  }),
  defineMethod({
    name: 'mcpServers.discover',
    permission: 'workspace',
    params: McpServerDiscover,
    handler: (_params, context) =>
      onHost(context, async () => ({
        servers: await listAgentMcpServers(agentMcpImportHost(context.runtime))
      }))
  }),
  defineMethod({
    name: 'mcpServers.move',
    permission: 'workspace',
    params: McpServerMove,
    handler: (params, context) =>
      onHost(context, () => importAgentMcpServer(context, params, moveAgentMcpServer), true)
  }),
  defineMethod({
    name: 'mcpServers.copy',
    permission: 'workspace',
    params: McpServerImport,
    handler: (params, context) =>
      onHost(context, () => importAgentMcpServer(context, params, copyAgentMcpServer), 'written')
  }),
  defineMethod({
    name: 'mcpServers.agentFiles.allow',
    permission: 'workspace',
    params: McpServerAgentFilesAllow,
    handler: (params, context) =>
      onHost(
        context,
        async () => ({ agentFiles: await setMcpAgentFileAllowed(params.agent, params.allowed) }),
        'written'
      )
  }),
  defineMethod({
    // `orca mcp connect` in Grok's, Cursor's and Droid's own MCP files. The answer carries the
    // relay token or a command's secret env, so this host's own CLI is the only caller it serves.
    name: 'mcpServers.connect',
    permission: 'workspace',
    params: McpServerConnect,
    handler: (params, context) =>
      onHost(context, () =>
        mcpServerConnection(context.runtime, {
          ...params,
          ...(context.pairedDeviceId !== undefined
            ? { pairedDeviceId: context.pairedDeviceId }
            : {})
        })
      )
  }),
  defineMethod({
    name: 'mcpServers.sessions.stale',
    // Terminals that outlived the host's restart count only once it has taken them back.
    requires: ['unshownPlacement'],
    permission: 'workspace',
    params: McpServerSessions,
    handler: (_params, context) => onHost(context, () => context.runtime.countMcpStaleTerminals())
  }),
  defineMethod({
    name: 'mcpServers.sessions.restart',
    requires: ['unshownPlacement'],
    permission: 'workspace',
    params: McpServerSessions,
    handler: (_params, context) => onHost(context, () => context.runtime.restartMcpStaleTerminals())
  })
]
