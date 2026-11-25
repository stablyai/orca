// mcpServers.*: the host's own MCP server list, for any of the user's clients. Every method refuses
// while the host's switch is off; every change tells the other clients to re-read.
import { join } from 'node:path'
import type { BotToolSignInAttemptView } from '../../../../shared/bot-tool-sign-in'
import type { McpServer } from '../../../../shared/mcp-servers/mcp-servers'
import {
  McpServerAdd,
  McpServerAgentFilesAllow,
  McpServerDiscover,
  McpServerImport,
  McpServerProblems,
  McpServerSetAgentEnabled,
  McpServerSetSharedProcess,
  McpServerSetWorkspaces,
  McpServerSignInFinish,
  McpServerSignInFlow,
  McpServerSignInStart,
  McpServerSignInWait,
  McpServerTarget,
  McpServerUpdate,
  McpServersList
} from '../../../../shared/rpc-contract/mcp-servers-params'
import { botToolProblems } from '../../../bots/bot-tools-host'
import { sharedBotToolHealthCheck } from '../../../bots/bot-tool-health-checks'
import { resolveBotToolInput } from '../../../bots/bot-tool-details'
import {
  cancelBotToolSignInAttempt,
  finishBotToolSignInAttempt,
  startBotToolSignInAttempt,
  waitBotToolSignInAttempt
} from '../../../bots/tool-oauth/bot-tool-sign-in-attempts'
import { MCP_HOST_LIST_RELAY_OWNER } from '../../../bots/tool-relay/bot-tool-relay'
import {
  addMcpServer,
  listMcpServers,
  mcpHostListFolder,
  mcpServerDetails,
  mcpServerIdsByName,
  mcpServerSignInKey,
  removeMcpServer,
  setMcpServerAgentEnabled,
  setMcpServerSharedProcess,
  setMcpServerWorkspaces,
  updateMcpServer
} from '../../../mcp-servers/mcp-host-list'
import { McpServersError } from '../../../mcp-servers/mcp-servers-error'
import { assertMcpServersFeatureEnabled } from '../../../mcp-servers/mcp-servers-feature'
import { rpcCallerOperationKey } from '../callers/rpc-caller-identity'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { botToolServerOf, toolsHomeFor } from './bots-tools'
import { inHostWords } from './bots-tools-owned-sign-in'

/** Runs `work` with the switch on; a change also tells every other client to re-read the list. */
async function onHost<T>(context: RpcContext, work: () => Promise<T>, changes = false): Promise<T> {
  assertMcpServersFeatureEnabled()
  const result = await work()
  if (changes) {
    context.runtime.notifyMcpServersChanged()
  }
  return result
}

const changed = (server: McpServer) => ({ server })

/** The device asking, by the identity its connection proved; only it may wait on, finish or cancel. */
function signInOwner(context: RpcContext): string {
  if (!context.caller) {
    throw new Error('This client can’t sign in to servers on this computer.')
  }
  return rpcCallerOperationKey(context.caller)
}

/** A finished sign-in changes the server's row for every client. */
function noteSignedIn(
  context: RpcContext,
  view: BotToolSignInAttemptView
): BotToolSignInAttemptView {
  if (view.state === 'done') {
    context.runtime.notifyMcpServersChanged()
  }
  return view
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
      onHost(context, async () => ({ servers: await listMcpServers() }))
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
        async () => changed(await updateMcpServer(params.id, params.version, params.config)),
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
        const ids = await mcpServerIdsByName(folder)
        // The bots' check, run by that agent's CLI over the host's list: one per agent and scope at a time.
        const byName = await sharedBotToolHealthCheck(
          MCP_HOST_LIST_RELAY_OWNER,
          `${agent}\0${remote ? 'remote' : 'all'}`,
          async (signal) =>
            botToolProblems(
              await toolsHomeFor(context.runtime, agent, {
                botId: MCP_HOST_LIST_RELAY_OWNER,
                folder,
                signInFolder: join(folder, '.orca', 'sign-in'),
                otherBotFolders: []
              }),
              { remote, signal }
            )
        )
        const problems = Object.fromEntries(
          Object.entries(byName).flatMap(([name, problem]) => {
            const id = ids.get(name)
            return id ? [[id, problem] as const] : []
          })
        )
        return { problems }
      })
  }),
  defineMethod({
    name: 'mcpServers.signIn.start',
    permission: 'workspace',
    params: McpServerSignInStart,
    handler: (params, context): Promise<BotToolSignInAttemptView> =>
      onHost(context, async () => {
        const owner = signInOwner(context)
        const key = await mcpServerSignInKey(params.id)
        if (!key) {
          throw new InvalidArgumentError('Orca doesn’t sign in to this server.')
        }
        return inHostWords(() => startBotToolSignInAttempt(owner, key, params.mode))
      })
  }),
  defineMethod({
    name: 'mcpServers.signIn.wait',
    permission: 'workspace',
    params: McpServerSignInWait,
    handler: (params, context) =>
      onHost(context, async () =>
        noteSignedIn(
          context,
          await waitBotToolSignInAttempt(
            signInOwner(context),
            params.flowId,
            params.afterRevision,
            context.signal
          )
        )
      )
  }),
  defineMethod({
    name: 'mcpServers.signIn.finish',
    permission: 'workspace',
    params: McpServerSignInFinish,
    handler: (params, context) =>
      onHost(context, async () => {
        const owner = signInOwner(context)
        return noteSignedIn(
          context,
          await inHostWords(() => finishBotToolSignInAttempt(owner, params.flowId, params.query))
        )
      })
  }),
  defineMethod({
    name: 'mcpServers.signIn.cancel',
    permission: 'workspace',
    params: McpServerSignInFlow,
    handler: (params, context) =>
      onHost(context, async () => cancelBotToolSignInAttempt(signInOwner(context), params.flowId))
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
    handler: () => notYet('mcpServers.discover')
  }),
  defineMethod({
    name: 'mcpServers.move',
    permission: 'workspace',
    params: McpServerImport,
    handler: () => notYet('mcpServers.move')
  }),
  defineMethod({
    name: 'mcpServers.copy',
    permission: 'workspace',
    params: McpServerImport,
    handler: () => notYet('mcpServers.copy')
  }),
  defineMethod({
    name: 'mcpServers.agentFiles.allow',
    permission: 'workspace',
    params: McpServerAgentFilesAllow,
    handler: () => notYet('mcpServers.agentFiles.allow')
  })
]
