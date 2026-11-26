// The RPCs a bot's tools use on the phone (Settings › Tools and the chat's tool card), all on the
// phone's bot allowlist and run on the bot's own host.
import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { NODE_PLATFORM_NAMES } from '../../transport/connection/mobile-runtime-host-platform'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { BOTS_TOOLS_OWNED_SIGN_IN_RUNTIME_CAPABILITY } from '../../../../src/shared/bot-runtime-capabilities'

export const SignInStatusSchema = z.looseObject({
  // A state or problem a newer host adds reads as not signed in, never as an unreadable list.
  state: z.enum(['signed-in', 'signed-out', 'lost']).catch('signed-out'),
  problem: z.enum(['unsupported', 'unreachable']).optional().catch(undefined)
})

export const OwnToolSchema = z.looseObject({
  name: z.string(),
  detail: z.string(),
  remote: z.boolean(),
  signIn: SignInStatusSchema.optional()
})

export type PhoneOwnTool = z.output<typeof OwnToolSchema>

const InheritedToolSchema = z.looseObject({ name: z.string(), plugin: z.literal(true).optional() })

export const botToolsListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.list',
    method: 'bots.tools.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    // Another agent's bot has no own tools here; its card reads as added.
    read: rpcResultVariant(
      'bot-tools',
      z.looseObject({
        own: z.array(OwnToolSchema).optional(),
        inherited: z.array(InheritedToolSchema).optional(),
        hostMcpServers: z.boolean().optional().catch(undefined)
      })
    )
  })
)

export const botToolProblemsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.problems',
    method: 'bots.tools.problems',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-tool-problems',
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
  })
)

/** Whether the bot's sessions also take its host's MCP servers; only a person sets it. */
export const botToolSetHostMcpServers = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.setHostMcpServers',
    method: 'bots.tools.setHostMcpServers',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-host-mcp-servers', z.looseObject({ hostMcpServers: z.boolean() }))
  })
)

export const botToolProblemsCancel = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.cancelProblems',
    method: 'bots.tools.cancelProblems',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-tool-problems-cancelled', z.unknown())
  })
)

export const botToolAdd = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.add',
    method: 'bots.tools.add',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-tool-added', z.looseObject({ tool: OwnToolSchema }))
  })
)

const MaskedSecretsSchema = z.array(z.looseObject({ key: z.string(), configured: z.boolean() }))

/** A saved tool or server, with its secrets as names only, and the version a save must match. */
export const ToolDetailsSchema = z.looseObject({
  version: z.string(),
  server: z.union([
    z.looseObject({
      name: z.string(),
      url: z.string(),
      transport: z.literal('http'),
      headers: MaskedSecretsSchema
    }),
    z.looseObject({
      name: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      env: MaskedSecretsSchema
    })
  ])
})

export const botToolDetailsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.details',
    method: 'bots.tools.details',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-tool-details', ToolDetailsSchema)
  })
)

/** The computer the bot's tools run on: its platform decides how env names compare. */
export const botToolContextRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.context',
    method: 'bots.tools.context',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-tool-context',
      z.looseObject({
        folder: z.string(),
        // One this build doesn't know compares env names case-sensitively, as every host but Windows.
        platform: z.enum(NODE_PLATFORM_NAMES).catch('linux')
      })
    )
  })
)

export const botToolUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.update',
    method: 'bots.tools.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-tool-updated', z.looseObject({ tool: OwnToolSchema }))
  })
)

export const botToolRemove = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.remove',
    method: 'bots.tools.remove',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-tool-removed', z.unknown())
  })
)

const FAILURES = [
  'no-tool',
  'unsupported',
  'unavailable',
  'expired',
  'cancelled',
  'denied',
  'issuer-mismatch',
  'refused',
  'superseded',
  'desktop-only'
] as const

// BotToolSignInAttemptView: an Orca-owned sign-in the host runs for this phone.
export const AttemptSchema = z.union([
  z.looseObject({
    flowId: z.string(),
    revision: z.number(),
    expiresAt: z.number(),
    state: z.literal('waiting'),
    authorizationUrl: z.string(),
    redirectUri: z.string()
  }),
  z.looseObject({
    flowId: z.string(),
    revision: z.number(),
    expiresAt: z.number(),
    state: z.enum(['finishing', 'done'])
  }),
  z.looseObject({
    flowId: z.string(),
    revision: z.number(),
    expiresAt: z.number(),
    state: z.literal('failed'),
    // A newer host's code this build doesn't know reads as a plain failure.
    code: z.enum(FAILURES).catch('refused')
  })
])

export type PhoneSignInAttempt = z.output<typeof AttemptSchema>

const attemptOperation = <
  Method extends 'bots.tools.signIn.start' | 'bots.tools.signIn.wait' | 'bots.tools.signIn.finish'
>(
  method: Method
) =>
  bindDeferredRpcOperation(
    defineRpcOperation({
      name: method,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant('bot-tool-sign-in', AttemptSchema)
    })
  )

export const botToolSignInStart = attemptOperation('bots.tools.signIn.start')
export const botToolSignInWait = attemptOperation('bots.tools.signIn.wait')
export const botToolSignInFinish = attemptOperation('bots.tools.signIn.finish')

export const botToolSignInCancel = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.signIn.cancel',
    method: 'bots.tools.signIn.cancel',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-tool-sign-in-cancelled', z.unknown())
  })
)

/** The host's side of an Orca-owned sign-in, bound to one bot tool or MCP server. */
export type PhoneOwnedSignInOps = {
  start: (client: RpcClient) => Promise<PhoneSignInAttempt>
  wait: (client: RpcClient, flowId: string, afterRevision: number) => Promise<PhoneSignInAttempt>
  finish: (client: RpcClient, flowId: string, query: string) => Promise<PhoneSignInAttempt>
  cancel: (client: RpcClient, flowId: string) => Promise<unknown>
  /** A host without it answers Update Orca instead of starting. */
  capability?: string
}

export const botOwnedSignInOps = (botId: string, name: string): PhoneOwnedSignInOps => ({
  start: (client) =>
    botToolSignInStart
      .request(client, { botId, name, mode: 'paste' })
      .then((response) => botToolSignInStart.interpret(response)),
  wait: (client, flowId, afterRevision) =>
    botToolSignInWait
      .request(client, { flowId, afterRevision }, { timeoutMs: 60_000 })
      .then((response) => botToolSignInWait.interpret(response)),
  finish: (client, flowId, query) =>
    botToolSignInFinish
      .request(client, { flowId, query })
      .then((response) => botToolSignInFinish.interpret(response)),
  cancel: (client, flowId) => botToolSignInCancel.request(client, { flowId }),
  capability: BOTS_TOOLS_OWNED_SIGN_IN_RUNTIME_CAPABILITY
})

/** A tool whose agent's CLI signs in: the page it names, or null when it opened one on its computer. */
export const botToolConnect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.connect',
    method: 'bots.tools.connect',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-tool-connect',
      z.looseObject({ authorizationUrl: z.string().nullable() })
    )
  })
)

export const botToolFinishHeldSignIn = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.finishSignIn',
    method: 'bots.tools.finishSignIn',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-tool-sign-in-finished', z.unknown())
  })
)

export const botToolSignInStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.signInStatus',
    method: 'bots.tools.signInStatus',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-tool-sign-in-status', z.looseObject({ status: z.string() }))
  })
)
