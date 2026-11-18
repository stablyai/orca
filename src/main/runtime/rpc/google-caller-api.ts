// The Google account a google.* call acts as, once the calling run may use Google at all, and who a
// bot's write is for when someone other than its owner asked.
import { askedByLine, withAskedBy, type BotWriteTurn } from '../../bots/bot-owner-writes'
import { readGoogleRefusal } from '../../bots/bot-google-access'
import { googleApi, type GoogleApi } from '../../google/google-api-client'
import { InvalidArgumentError, type RpcContext } from './core'
import { readBotWriteTurn } from './methods/bot-write-turn'

export function googleApiForCaller(
  params: { callerSessionId?: string; account?: string },
  context: RpcContext
): GoogleApi {
  const refusal = readGoogleRefusal(context.runtime, params.callerSessionId, context.pairedDeviceId)
  if (refusal) {
    throw new InvalidArgumentError(refusal)
  }
  return googleApi(params.account)
}

/** The calling bot's turn for a write it makes as its owner; null for the owner or when unreadable. */
function readGoogleWriteTurn(
  callerSessionId: string | undefined,
  context: RpcContext
): Promise<BotWriteTurn | null> {
  return readBotWriteTurn(context.runtime, callerSessionId, context.pairedDeviceId).catch(
    (error: unknown) => {
      console.warn('[bots] could not read the turn for a Google write', error)
      return null
    }
  )
}

/** "asked by <name> via <bot>" for a bot's write when someone other than its owner asked, else null. */
export async function googleWriteAskedBy(
  callerSessionId: string | undefined,
  context: RpcContext
): Promise<string | null> {
  return askedByLine(await readGoogleWriteTurn(callerSessionId, context))
}

/** The text ending with "asked by <name> via <bot>" when a bot writes it for someone else. */
export async function attributedGoogleText(
  text: string | undefined,
  callerSessionId: string | undefined,
  context: RpcContext
): Promise<string | undefined> {
  return text === undefined
    ? undefined
    : withAskedBy(text, await readGoogleWriteTurn(callerSessionId, context))
}
