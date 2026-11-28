// Linking Linear and GitHub, their default bot, and Google for a bot and on its host (its sign-in too): all on the
// phone's bot allowlist.
// The trip's own answers are BotSlackResult, as the host's other connector calls are.
import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

const refusal = z.looseObject({ ok: z.literal(false), error: z.string() })
const result = <Value extends z.ZodType>(value: Value) =>
  z.union([z.looseObject({ ok: z.literal(true), value }), refusal])

function operation<
  Method extends
    | 'bots.connect.start'
    | 'bots.connect.wait'
    | 'bots.connect.cancel'
    | 'bots.linear.setDefaultBot'
    | 'bots.linear.unlink'
    | 'bots.github.setDefaultBot'
    | 'bots.github.unlink'
    | 'google.bot.set'
    | 'bots.googleSetup.start'
    | 'google.client.import'
    | 'google.client.export'
    | 'google.default.set'
    | 'google.disconnect'
    | 'google.signIn.start'
    | 'google.signIn.wait'
    | 'google.signIn.cancel',
  Value extends z.ZodType
>(method: Method, read: Value) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name: method,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant(method, read)
    })
  )
}

/** What a finished trip linked; null when it ended at "Open Orca", which the phone can't redeem. */
const ConnectLink = z
  .looseObject({
    workspace: z.looseObject({ id: z.string() }).optional(),
    install: z.string().optional()
  })
  .nullable()
export type PhoneConnectLink = z.infer<typeof ConnectLink>

export const connectStart = operation(
  'bots.connect.start',
  result(z.looseObject({ tripId: z.string(), authorizeUrl: z.string() }))
)

export const connectWait = operation(
  'bots.connect.wait',
  z.union([
    z.looseObject({ state: z.literal('waiting') }),
    z.looseObject({ state: z.literal('done'), result: result(ConnectLink) })
  ])
)

export const connectCancel = operation('bots.connect.cancel', z.unknown())

// The host's success carries no value, which JSON drops.
export const linearSetDefaultBot = operation(
  'bots.linear.setDefaultBot',
  result(z.unknown().optional())
)
export const gitHubSetDefaultBot = operation(
  'bots.github.setDefaultBot',
  result(z.unknown().optional())
)
export const gitHubUnlink = operation('bots.github.unlink', result(z.unknown().optional()))
export const linearUnlink = operation('bots.linear.unlink', result(z.unknown().optional()))

export const googleBotSet = operation('google.bot.set', z.unknown())

/** Starts Google's setup in the bot's chat, where its cards carry on. */
export const googleSetupStart = operation('bots.googleSetup.start', z.unknown())

/** Adds the team's Google app file to the host. */
export const googleClientImport = operation('google.client.import', z.unknown())

/** The team's Google app file, for Share setup. */
export const googleClientExport = operation(
  'google.client.export',
  z.looseObject({ file: z.string() })
)
export const googleDefaultSet = operation('google.default.set', z.unknown())
export const googleDisconnect = operation('google.disconnect', z.unknown())

/** A Google sign-in on the host: `prompt` once it has Google's page; it ends signedIn, failed or cancelled. */
const GoogleSignInStatus = z.looseObject({
  flowId: z.string(),
  revision: z.number(),
  phase: z.string(),
  prompt: z.looseObject({ authorizeUrl: z.string() }).optional(),
  error: z.string().optional()
})
export const googleSignInStart = operation('google.signIn.start', GoogleSignInStatus)
export const googleSignInWait = operation('google.signIn.wait', GoogleSignInStatus)
export const googleSignInCancel = operation('google.signIn.cancel', z.unknown())
