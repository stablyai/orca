// The RPCs the phone's MCP servers screens use, all on the phone's allowlist and run on the host the
// screen names. Every one is refused while the host's switch is off, which the screen never reaches.
import * as z from 'zod'
import type { McpFileAgent } from '../../../src/shared/mcp-servers/mcp-servers'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import {
  rpcResultVariant,
  type NamedRpcResultReader
} from '../transport/rpc/rpc-operation-result-reader'
import type { RpcMethodName } from '../../../src/shared/rpc-contract/rpc-params-catalog.generated'
import { RpcRefusedError } from '../transport/rpc/rpc-refused-error'
import { isMobileMethodUnavailableError } from '../transport/rpc/mobile-method-unavailable'
import {
  AttemptSchema,
  SignInStatusSchema,
  ToolDetailsSchema,
  type PhoneOwnedSignInOps
} from '../bots/tools/bot-tool-operations'

// An entry Orca can't read is on nowhere, never everywhere, as the host reads it.
const NOWHERE = { later: false, on: [], off: [] }

export const McpServerSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  detail: z.string(),
  transport: z.enum(['http', 'command']).catch('http'),
  remote: z.boolean().catch(false),
  signIn: SignInStatusSchema.optional().catch(undefined),
  agentsOff: z.array(z.string()).catch([]),
  workspaces: z
    .looseObject({ later: z.boolean(), on: z.array(z.string()), off: z.array(z.string()) })
    .catch(NOWHERE),
  sharedProcess: z.boolean().catch(false),
  /** From a plugin: its details and removal are the plugin's. */
  plugin: z.looseObject({ key: z.string(), name: z.string() }).optional().catch(undefined)
})

export type PhoneMcpServer = z.output<typeof McpServerSchema>
export type PhoneMcpWorkspaces = PhoneMcpServer['workspaces']

// Whether the user let Orca keep its servers in each file-based agent's own settings file.
const AgentFilesSchema = z
  .looseObject({
    grok: z.boolean().catch(false),
    cursor: z.boolean().catch(false),
    droid: z.boolean().catch(false)
  } satisfies Record<McpFileAgent, z.ZodType>)
  .catch({ grok: false, cursor: false, droid: false })

/** Per agent, a problem with every server for it: an org policy, or no route into its terminal. */
const AgentProblemsSchema = z
  .record(
    z.string(),
    z.looseObject({
      // A kind this app doesn't know keeps its host's line, not the org-policy one.
      kind: z.string(),
      detail: z.string()
    })
  )
  .optional()
  .catch(undefined)

const ListSchema = z.looseObject({
  servers: z.array(McpServerSchema),
  agentFiles: AgentFilesSchema,
  agentProblems: AgentProblemsSchema
})

export type PhoneMcpServerList = z.output<typeof ListSchema>

const changed = (name: string) => rpcResultVariant(name, z.looseObject({ server: McpServerSchema }))

function operation<Method extends RpcMethodName, Variant extends string, Value>(
  method: Method,
  read: NamedRpcResultReader<Variant, Value>
) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name: method,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read
    })
  )
}

export const mcpServersListRead = operation(
  'mcpServers.list',
  rpcResultVariant('mcp-servers', ListSchema)
)
// A paste naming several servers adds each; `server` is the first.
export const mcpServerAdd = operation(
  'mcpServers.add',
  rpcResultVariant(
    'mcp-server-added',
    z.looseObject({ server: McpServerSchema, servers: z.array(McpServerSchema).optional() })
  )
)

/** What a Custom server paste names, under the names Add would keep; the host reads the paste. */
export const mcpServerPreviewPaste = operation(
  'mcpServers.previewPaste',
  rpcResultVariant(
    'mcp-paste-preview',
    z.looseObject({
      servers: z.array(
        z.looseObject({
          name: z.string(),
          transport: z.enum(['http', 'command']).catch('http'),
          detail: z.string()
        })
      )
    })
  )
)
export const mcpServerRemove = operation(
  'mcpServers.remove',
  rpcResultVariant('mcp-server-removed', z.unknown())
)
export const mcpServerDetailsRead = operation(
  'mcpServers.details',
  rpcResultVariant('mcp-server-details', ToolDetailsSchema)
)
export const mcpServerSetAgentEnabled = operation(
  'mcpServers.setAgentEnabled',
  changed('mcp-server-agent')
)
export const mcpServerSetWorkspaces = operation(
  'mcpServers.setWorkspaces',
  changed('mcp-server-workspaces')
)
export const mcpServerSetSharedProcess = operation(
  'mcpServers.setSharedProcess',
  changed('mcp-server-shared')
)
export const mcpServerSignOut = operation('mcpServers.signOut', changed('mcp-server-signed-out'))
export const mcpServerAgentFilesAllow = operation(
  'mcpServers.agentFiles.allow',
  rpcResultVariant('mcp-agent-files', z.looseObject({ agentFiles: AgentFilesSchema }))
)

export const mcpServerProblemsRead = operation(
  'mcpServers.problems',
  rpcResultVariant(
    'mcp-server-problems',
    z.looseObject({
      problems: z.record(
        z.string(),
        z.looseObject({
          kind: z.enum(['sign-in', 'failed', 'unconfirmed']),
          detail: z.string().optional()
        })
      )
    })
  )
)
export const mcpServerProblemsCancel = operation(
  'mcpServers.cancelProblems',
  rpcResultVariant('mcp-problems-cancelled', z.unknown())
)

const DiscoveredSchema = z.looseObject({
  key: z.string(),
  name: z.string(),
  detail: z.string(),
  transport: z.enum(['http', 'command']).catch('http'),
  agents: z.array(z.string()).catch([]),
  // Absent from older hosts, which take it out of every agent.
  removesFrom: z.array(z.string()).optional().catch(undefined),
  files: z.array(z.string()).catch([]),
  projectNames: z.array(z.string()).catch([]),
  movable: z.boolean().catch(false)
})

export type PhoneDiscoveredMcpServer = z.output<typeof DiscoveredSchema>

export const mcpServersDiscoverRead = operation(
  'mcpServers.discover',
  rpcResultVariant('mcp-servers-discovered', z.looseObject({ servers: z.array(DiscoveredSchema) }))
)
export const mcpServerMove = operation('mcpServers.move', changed('mcp-server-moved'))
export const mcpServerCopy = operation('mcpServers.copy', changed('mcp-server-copied'))

export const mcpSessionsStaleRead = operation(
  'mcpServers.sessions.stale',
  rpcResultVariant(
    'mcp-sessions-stale',
    z.looseObject({ count: z.number(), restartable: z.number() })
  )
)
export const mcpSessionsRestart = operation(
  'mcpServers.sessions.restart',
  rpcResultVariant(
    'mcp-sessions-restarted',
    z.looseObject({ restarted: z.number(), skipped: z.number() })
  )
)

/** This host's folder workspaces, by the names the user gave them. */
export const mcpFolderWorkspacesRead = operation(
  'folderWorkspace.list',
  rpcResultVariant(
    'mcp-folder-workspaces',
    z.looseObject({
      folderWorkspaces: z.array(
        z.looseObject({
          id: z.string(),
          name: z.string().optional().catch(undefined),
          folderPath: z.string(),
          connectionId: z.string().nullish().catch(null),
          executionHostId: z.string().nullish().catch(null),
          isArchived: z.boolean().optional().catch(false)
        })
      )
    })
  )
)

const signInAttempt = <
  Method extends 'mcpServers.signIn.start' | 'mcpServers.signIn.wait' | 'mcpServers.signIn.finish'
>(
  method: Method
) => operation(method, rpcResultVariant('mcp-server-sign-in', AttemptSchema))

const signInStart = signInAttempt('mcpServers.signIn.start')
const signInWait = signInAttempt('mcpServers.signIn.wait')
const signInFinish = signInAttempt('mcpServers.signIn.finish')
const signInCancel = operation(
  'mcpServers.signIn.cancel',
  rpcResultVariant('mcp-sign-in-cancelled', z.unknown())
)

/** The host's sign-in to one server, for the shared paste-back page. */
export const mcpServerSignInOps = (id: string): PhoneOwnedSignInOps => ({
  start: (client) =>
    signInStart
      .request(client, { id, mode: 'paste' })
      .then((reply) => signInStart.interpret(reply)),
  wait: (client, flowId, afterRevision) =>
    signInWait
      .request(client, { flowId, afterRevision }, { timeoutMs: 60_000 })
      .then((reply) => signInWait.interpret(reply)),
  finish: (client, flowId, query) =>
    signInFinish.request(client, { flowId, query }).then((reply) => signInFinish.interpret(reply)),
  cancel: (client, flowId) => signInCancel.request(client, { flowId })
})

/** A method this host doesn't have yet: a later PR fills it in, so the screen hides what needs it. */
export function isMcpMethodNotYet(error: unknown): boolean {
  return (
    error instanceof RpcRefusedError &&
    (error.code === 'mcp_servers_not_yet' ||
      isMobileMethodUnavailableError(error.code, error.message))
  )
}
