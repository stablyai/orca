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
  McpServerProblems,
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
  addMcpServer,
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
import { McpServersError } from '../../../mcp-servers/mcp-servers-error'
import { assertMcpServersFeatureEnabled } from '../../../mcp-servers/mcp-servers-feature'
import { mcpHostListFolder } from '../../../mcp-servers/mcp-host-list-folder'
import { withMcpAgentProblems } from '../../../mcp-servers/mcp-agent-problems'
import { mcpServerConnection } from '../../../mcp-servers/mcp-server-connection'
import { rpcCallerOperationKey } from '../callers/rpc-caller-identity'
import { defineMethod, type RpcContext } from '../core'
import { botToolServerOf, toolsHomeFor } from './bots-tools'
import {
  agentMcpImportHost,
  copyAgentMcpServer,
  importAgentMcpServer,
  listAgentMcpServers,
  moveAgentMcpServer
} from './mcp-servers-import'

/** Runs `work` with the switch on; a change also tells every other client to re-read the list. */
export async function onHost<T>(
  context: RpcContext,
  work: () => Promise<T>,
  changes = false
): Promise<T> {
  assertMcpServersFeatureEnabled()
  const result = await work()
  if (changes) {
    context.runtime.notifyMcpServersChanged()
  }
  return result
}

export const changed = (server: McpServer) => ({ server })

/** The client a problems request is from: its window or socket, so a cancel lets go of only its own. */
function problemsClient(context: RpcContext): string {
  return (
    context.connectionId ??
    (context.caller ? rpcCallerOperationKey(context.caller) : 'unidentified')
  )
}

/** A method later hosts fill in; this one refuses it in words a client can tell apart. */
async function notYet(method: string): Promise<never> {
  assertMcpServersFeatureEnabled()
  throw new McpServersError('mcp_servers_not_yet', `${method} isn’t available on this host yet.`)
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
              ? resolveBotToolInput(params.config)
              : botToolServerOf(params.source, params.name)
          const nameGiven = 'config' in params || params.name !== undefined
          return changed(await addMcpServer(given, { nameGiven, signal: context.signal }))
        },
        true
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
        true
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
        true
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
        // The bots' check, run by that agent's CLI over the host's list: one per agent, scope and list
        // write (epoch) at a time, so a request after an edit never joins a check of the old list. Read
        // without waiting, so the request joins before a cancel sent right after it can arrive.
        // Ids come from the checked run's own read, so a request that joins it gets that run's.
        const problems = await joinHostListHealthCheck(
          `${agent}\0${remote ? 'remote' : 'all'}\0${botToolsEpoch(folder)}`,
          problemsClient(context),
          context.signal,
          async (signal) => {
            const ids = await mcpServerIdsByName(folder)
            const home = await toolsHomeFor(context.runtime, agent, {
              botId: MCP_HOST_LIST_RELAY_OWNER,
              folder,
              signInFolder: join(folder, '.orca', 'sign-in'),
              otherBotFolders: []
            })
            const byName = await botToolProblems(home, { remote, signal })
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
    params: McpServersList,
    handler: (_params, context) =>
      onHost(context, async () => {
        cancelHostListHealthChecks(problemsClient(context))
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
        true
      )
  }),
  defineMethod({
    name: 'mcpServers.setWorkspaces',
    permission: 'workspace',
    params: McpServerSetWorkspaces,
    handler: (params, context) =>
      onHost(
        context,
        async () => changed(await setMcpServerWorkspaces(params.id, params.workspaces)),
        true
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
        true
      )
  }),
  defineMethod({
    name: 'mcpServers.discover',
    permission: 'workspace',
    params: McpServerDiscover,
    handler: (_params, context) =>
      onHost(context, async () => ({
        servers: await listAgentMcpServers(await agentMcpImportHost(context.runtime))
      }))
  }),
  defineMethod({
    name: 'mcpServers.move',
    permission: 'workspace',
    params: McpServerImport,
    handler: (params, context) =>
      onHost(context, () => importAgentMcpServer(context, params.key, moveAgentMcpServer), true)
  }),
  defineMethod({
    name: 'mcpServers.copy',
    permission: 'workspace',
    params: McpServerImport,
    handler: (params, context) =>
      onHost(context, () => importAgentMcpServer(context, params.key, copyAgentMcpServer), true)
  }),
  defineMethod({
    name: 'mcpServers.agentFiles.allow',
    permission: 'workspace',
    params: McpServerAgentFilesAllow,
    handler: (params, context) =>
      onHost(
        context,
        async () => ({ agentFiles: await setMcpAgentFileAllowed(params.agent, params.allowed) }),
        true
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
    permission: 'workspace',
    params: McpServerSessions,
    handler: () => notYet('mcpServers.sessions.stale')
  }),
  defineMethod({
    name: 'mcpServers.sessions.restart',
    permission: 'workspace',
    params: McpServerSessions,
    handler: () => notYet('mcpServers.sessions.restart')
  })
]
