// The Google account a google.* call acts as, once the calling run may use Google at all, and who a
// bot's write is for when someone other than its owner asked.
import { askedByLine, withAskedBy, type BotWriteTurn } from '../../bots/bot-owner-writes'
import { readGoogleRefusal } from '../../bots/bot-google-access'
import { botOfToken } from '../../bots/bot-of-caller'
import { botOfSession } from '../../bots/bot-session-tabs'
import { googleApi, type GoogleApi } from '../../google/google-api-client'
import { listGoogleAccounts, readGoogleDefaultAccount } from '../../google/google-credential-store'
import { gmailLinksAccount } from '../../google/google-gmail-ref'
import {
  botGoogleAccess,
  botGoogleAccountFilter,
  botGoogleDefault,
  botMayUseGoogleAccount,
  googleAccountNotAllowed
} from '../../../shared/google/google-bot-accounts'
import { InvalidArgumentError, type RpcContext } from './core'
import { readBotWriteTurn } from './methods/bot-write-turn'

type GoogleCaller = { botToken?: string; callerSessionId?: string }

/** `gmailRefs`: the Gmail refs a command names; a web link's account stands in for --account. */
export async function googleApiForCaller(
  params: GoogleCaller & { account?: string },
  context: RpcContext,
  gmailRefs: readonly (string | undefined)[] = []
): Promise<GoogleApi> {
  const refusal = readGoogleRefusal(context.runtime, params.botToken, context.pairedDeviceId)
  if (refusal) {
    throw new InvalidArgumentError(refusal)
  }
  const linked = params.account
    ? undefined
    : await gmailLinksAccount(
        gmailRefs.filter((ref) => ref !== undefined),
        () => callerGoogleAccounts(params, context)
      )
  return googleApi(
    await googleCallerAccount(linked ? { ...params, account: linked } : params, context)
  )
}

/** The connected accounts this caller may name: a bot limited to some sees only those. */
async function callerGoogleAccounts(params: GoogleCaller, context: RpcContext): Promise<string[]> {
  const caller = botOfToken(context.runtime, params.botToken, context.pairedDeviceId)
  const mayUse =
    caller.kind === 'bot' ? botGoogleAccountFilter(botGoogleAccess(caller.bot)) : undefined
  const emails = (await listGoogleAccounts()).map((entry) => entry.email)
  return mayUse ? emails.filter(mayUse) : emails
}

/**
 * The account a call acts as. A bot limited to some accounts may name only those, and without
 * --account uses its own default; the owner, and a bot with every account, keep the computer's.
 */
export async function googleCallerAccount(
  params: GoogleCaller & { account?: string },
  context: Pick<RpcContext, 'runtime' | 'pairedDeviceId'>
): Promise<string | undefined> {
  const caller = botOfToken(context.runtime, params.botToken, context.pairedDeviceId)
  const access = caller.kind === 'bot' ? botGoogleAccess(caller.bot) : null
  if (caller.kind !== 'bot' || access?.kind !== 'some') {
    return params.account
  }
  if (params.account) {
    if (!botMayUseGoogleAccount(access, params.account)) {
      throw new InvalidArgumentError(
        googleAccountNotAllowed(caller.bot.name, params.account, access)
      )
    }
    return params.account
  }
  const fallback = botGoogleDefault(access, await readGoogleDefaultAccount())
  if ('unreadable' in fallback) {
    throw new InvalidArgumentError(
      `Couldn't read this computer's default Google account. ${fallback.unreadable} Name one with --account: ${access.accounts.join(', ')}.`
    )
  }
  const account = fallback.email
  if (!account) {
    throw new InvalidArgumentError(
      `No Google account is chosen for ${caller.bot.name}. Ask your owner to choose one in Orca.`
    )
  }
  return account
}

/** The calling bot's turn for a write it makes as its owner; null for the owner, when unreadable, or
 *  when the session named is not a chat of the token's bot. */
async function readGoogleWriteTurn(
  caller: GoogleCaller,
  context: RpcContext
): Promise<BotWriteTurn | null> {
  const bot = botOfToken(context.runtime, caller.botToken, context.pairedDeviceId)
  const sessionId = caller.callerSessionId
  if (
    bot.kind !== 'bot' ||
    !sessionId ||
    botOfSession(context.runtime.bots, sessionId)?.id !== bot.bot.id
  ) {
    return null
  }
  return readBotWriteTurn(context.runtime, sessionId, context.pairedDeviceId).catch(
    (error: unknown) => {
      console.warn('[bots] could not read the turn for a Google write', error)
      return null
    }
  )
}

/** "asked by <name> via <bot>" for a bot's write when someone other than its owner asked, else null. */
export async function googleWriteAskedBy(
  caller: GoogleCaller,
  context: RpcContext
): Promise<string | null> {
  return askedByLine(await readGoogleWriteTurn(caller, context))
}

/** The text ending with "asked by <name> via <bot>" when a bot writes it for someone else. */
export async function attributedGoogleText(
  text: string | undefined,
  caller: GoogleCaller,
  context: RpcContext
): Promise<string | undefined> {
  return text === undefined
    ? undefined
    : withAskedBy(text, await readGoogleWriteTurn(caller, context))
}
