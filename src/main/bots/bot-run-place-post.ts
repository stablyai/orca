// A finished bot run's result posted to a Slack channel or a Linear issue, as the bot: its main
// place, or the copy named besides the thread it answers.
import type { AutomationBotResultsTo } from '../../shared/automations/automation-definition'
import { CONNECTOR_CLIENT_LIMITS } from '../../shared/connectors/connector-cloud-contract'
import {
  hostNotSignedIn,
  serverSignInSteps,
  type OrcaSignInServer
} from '../../shared/bots/host-orca-sign-in'
import { capAnswer } from '../connector-cloud/connector-snapshot'
import { resultPlaceValue } from '../automations/bot-automation-place-refs'
import { withProvenance } from './bot-run-result-provenance'
import type { BotRunDeliveryDependencies, BotRunResult } from './bot-run-results'

export const POST_COPY = {
  cloudOff: "Orca Cloud isn't connected, so the result wasn't posted.",
  signedOut: (place: string, server: OrcaSignInServer, botName: string) => {
    const steps = serverSignInSteps(server, botName, 'owner')
    return steps
      ? `Not posted to ${place}. ${hostNotSignedIn(server)}. ${steps}`
      : `Not posted to ${place}: this computer isn't signed in to Orca Cloud.`
  },
  postFailed: "The result couldn't be posted."
}

/** Posts the result to the channel or issue; resolves to why it wasn't posted, or undefined. */
export async function postToPlace(
  deps: BotRunDeliveryDependencies,
  result: BotRunResult,
  resultsTo: Extract<AutomationBotResultsTo, object>,
  message: string
): Promise<string | undefined> {
  const { automation, bot } = result
  const words = withProvenance(message, automation)
  const text = capAnswer(words, CONNECTOR_CLIENT_LIMITS.maxLastAssistantMessageBytes)
  const postId = result.run.id
  // The ref where the host saved one; the id or key where it saved only that.
  const place = resultPlaceValue(resultsTo)
  // Said where the result shows, not only in run history afterwards.
  if (deps.cloudSignedOut()) {
    const error = POST_COPY.signedOut(
      'channel' in resultsTo ? 'Slack' : 'Linear',
      deps.signInServer?.(),
      bot.name
    )
    await deps
      .noteToRun(result.sessionId, `result-not-posted:${result.run.id}`, error)
      .catch((noteError: unknown) =>
        console.warn('[bots] could not note an unposted result in its run', noteError)
      )
    return error
  }
  const turnFor = 'channel' in resultsTo ? await deps.turnForOf(result.sessionId) : undefined
  const posted = await deps.postAsBot(
    bot,
    resultsTo.ref
      ? { postId, ref: resultsTo.ref, text, ...(turnFor ? { turnFor } : {}) }
      : 'channel' in resultsTo
        ? { postId, channelId: place, text, ...(turnFor ? { turnFor } : {}) }
        : { postId, issue: place, text }
  )
  if (!posted?.ok) {
    return posted ? POST_COPY.postFailed : POST_COPY.cloudOff
  }
  await noteNotices(deps, result, posted.value?.notices)
  return undefined
}

// Why the result can't wake an Orca bot it mentions, said in the run where it shows.
export async function noteNotices(
  deps: BotRunDeliveryDependencies,
  result: BotRunResult,
  notices: readonly string[] | undefined
): Promise<void> {
  if (!notices?.length) {
    return
  }
  await deps
    .noteToRun(result.sessionId, `result-notices:${result.run.id}`, notices.join('\n'))
    .catch((noteError: unknown) =>
      console.warn('[bots] could not note a result’s notices in its run', noteError)
    )
}
