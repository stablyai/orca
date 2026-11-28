// How a remote ask refused before sending reads: the English the ask stores, and its code when a
// client can say it in its reader's language.
import { BotFailureError, botFailure, type BotFailure } from '../../shared/bots/bot-failure-copy'

/** The paired computer couldn't be reached. `unreachable`: it gave no answer (off, asleep or off
 *  the network), so posting again may reach it, unlike any other refusal. */
export class RemoteComputerRefusal extends Error {
  constructor(
    readonly host: string,
    readonly detail: string,
    readonly unreachable: boolean
  ) {
    super(`Couldn't reach ${host}. ${detail}`.trim())
  }
}

/** How a refusal before sending reads on the ask, with its code when it has words a client can say. */
export function refusedAsk(error: unknown): { error: string; failure?: BotFailure } {
  if (error instanceof BotFailureError) {
    return { error: error.message, failure: error.data.botFailure }
  }
  if (!(error instanceof RemoteComputerRefusal)) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  // A detail with edge spaces or none reads only as its English.
  const coded = error.detail !== '' && error.detail === error.detail.trim()
  if (!error.unreachable) {
    return {
      error: error.message,
      ...(coded
        ? {
            failure: botFailure('groupRemoteUnreachable', {
              host: error.host,
              detail: error.detail
            })
          }
        : {})
    }
  }
  const reason = error.message
  const detail = /[.!?]$/.test(error.detail) ? error.detail : `${error.detail}.`
  return {
    error: `${/[.!?]$/.test(reason) ? reason : `${reason}.`} Post again to retry.`,
    ...(coded
      ? { failure: botFailure('groupRemoteUnreachableRetry', { host: error.host, detail }) }
      : {})
  }
}
