// The Google account a google.* call acts as, once the calling run may use Google at all, and who a
// bot's write is for when someone other than its owner asked.
import { askedByLine, withAskedBy, type BotWriteTurn } from '../../bots/bot-owner-writes'
import { readGoogleRefusal } from '../../bots/bot-google-access'
import { botOfToken } from '../../bots/bot-of-caller'
import { botOfSession } from '../../bots/bot-session-tabs'
import { googleApi, type GoogleApi } from '../../google/google-api-client'
import { InvalidArgumentError, type RpcContext } from './core'
import { readBotWriteTurn } from './methods/bot-write-turn'

type GoogleCaller = { botToken?: string; callerSessionId?: string }

export function googleApiForCaller(
  params: GoogleCaller & { account?: string },
  context: RpcContext
): GoogleApi {
  const refusal = readGoogleRefusal(context.runtime, params.botToken, context.pairedDeviceId)
  if (refusal) {
    throw new InvalidArgumentError(refusal)
  }
  return googleApi(params.account)
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
