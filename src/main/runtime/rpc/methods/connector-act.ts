import type { ConnectorCloudFeature } from '../../../../shared/connectors/connector-cloud-contract'
import type { ConnectorActErrorCode } from '../../../../shared/connector-action-contract'
import { ConnectorAct } from '../../../../shared/rpc-contract/connectors/connector-params'
import { botOfSession } from '../../../bots/bot-session-tabs'
import {
  LOOK_AROUND_REFUSAL,
  lookAroundConnectorVerbAllowed,
  REPLY_ONLY_REFUSAL
} from '../../../bots/bot-look-around-policy'
import { postConnectorAction } from '../../../connector-cloud/connector-actions'
import { cloudConversation } from '../../../../shared/connectors/connector-cloud-contract'
import { chatPaneKey } from '../../../external-conversations/external-conversation-chat'
import { defineMethod } from '../core'
import { botTurnFor } from '../../../bots/bot-turn-for'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import { noteBotRequestPost } from './orchestration/messaging/bot-request-outcome'

/** A refusal whose code the CLI reads and whose message a bot can act on. */
export class ConnectorActError extends Error {
  constructor(
    readonly code: ConnectorActErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** `slack find --search` with no place searches the Slack workspace of the conversation the run
 *  answers (its id starts with the workspace); elsewhere the bot names one. */
function searchedWorkspace(key: { source: string; externalId: string } | undefined): string {
  const workspace = key?.source === 'slack' ? key.externalId.split(':')[0] : undefined
  if (!workspace) {
    throw new ConnectorActError(
      'connector_invalid_request',
      'Name the Slack workspace to search: `orca slack find --search "<words>" --workspace <name>` (`orca bot connectors` lists them).'
    )
  }
  return `slack:${workspace}:workspace`
}

/** A cloud failure in words; only an answer that never came is "didn't answer". */
export function actFailure(
  verb: string,
  ref: string | undefined,
  failure: { status: number | null; error: string | null }
): ConnectorActError {
  if (failure.status === 401 && failure.error === 'signed_out') {
    return new ConnectorActError(
      'connector_not_connected',
      'Orca is signed out of Orca Cloud: sign in to Orca Cloud on this computer, then try again.'
    )
  }
  if (failure.status === null || failure.status >= 500 || failure.status === 429) {
    if (verb === 'set') {
      return new ConnectorActError(
        'connector_set_unknown',
        `Orca Cloud didn't answer, so the change may have been made. Read ${ref ?? 'the issue'} before trying again.`
      )
    }
    // A reply's files may have been queued too: a retry under new ids would post them twice.
    if (verb === 'post' || verb === 'attach' || verb === 'reply') {
      return new ConnectorActError(
        'connector_post_unknown',
        `Orca Cloud didn't answer, so the ${verb === 'post' ? 'post' : 'file'} may have gone. Read ${ref ?? (verb === 'reply' ? 'the thread that woke you' : 'the place')} before trying again.`
      )
    }
    return new ConnectorActError(
      'connector_unavailable',
      verb === 'edit' || verb === 'delete'
        ? `Orca Cloud didn't answer, so the ${verb} may have gone through. Read ${ref ?? 'the message'} before trying again.`
        : "Orca Cloud didn't answer; nothing was done. Try again in a moment."
    )
  }
  if (failure.status === 404 && failure.error === 'unknown_bot') {
    return new ConnectorActError(
      'bot_not_in_cloud',
      "This bot isn't on Orca Cloud from this machine yet: connect it to Slack, Linear or GitHub, or wait a moment after connecting it."
    )
  }
  const reason = failure.error ?? `HTTP ${failure.status}`
  return failure.status === 400
    ? new ConnectorActError(
        'connector_invalid_request',
        `Orca Cloud refused the request (${reason}).`
      )
    : new ConnectorActError('connector_refused', `Orca Cloud refused it (${reason}).`)
}

// `orca slack ...`, `orca bot connectors` and `orca bot reply --react`: the calling chat names its bot; the cloud acts as it.
export const CONNECTOR_ACT_METHOD = defineMethod({
  name: 'connector.act',
  permission: 'workspace',
  params: ConnectorAct,
  handler: async ({ sessionId, verb, ref, args }, context) => {
    const { runtime } = context
    const bot = runtime.bots.enabled() ? botOfSession(runtime.bots, sessionId) : null
    if (!bot) {
      throw new ConnectorActError(
        'not_a_bot_session',
        "This isn't a bot's chat. Connector actions act as a bot: run them from a bot's chat or one of its automation runs."
      )
    }
    if (runtime.lookAround.botOfTidyUp(sessionId)) {
      throw new ConnectorActError('look_around_reads_only', REPLY_ONLY_REFUSAL)
    }
    if (runtime.lookAround.botOfLook(sessionId) && !lookAroundConnectorVerbAllowed(verb, args)) {
      throw new ConnectorActError('look_around_reads_only', LOOK_AROUND_REFUSAL)
    }
    const cloud = runtime.getConnectorCloud()
    const features = cloud?.cloudFeatures()
    if (!cloud || !features) {
      throw new ConnectorActError(
        'connector_not_connected',
        "Orca isn't connected to Orca Cloud: sign in to Orca and connect a bot to Slack, Linear or GitHub, then try again."
      )
    }
    if (!features.has('actions' satisfies ConnectorCloudFeature)) {
      throw new ConnectorActError(
        'cloud_lacks_actions',
        "Orca Cloud doesn't take connector actions yet. Update Orca and try again later."
      )
    }
    if (verb === 'places' && !features.has('places' satisfies ConnectorCloudFeature)) {
      throw new ConnectorActError(
        'cloud_lacks_places',
        "Orca Cloud can't list the bot's workspaces yet. Update Orca, and find Slack channels with `orca slack find <name|link>`."
      )
    }
    if (args.title && !features.has('create' satisfies ConnectorCloudFeature)) {
      throw new ConnectorActError(
        'cloud_lacks_create',
        "Orca Cloud can't make issues yet. Say what the issue should be instead, and try again after Orca Cloud updates."
      )
    }
    if (verb === 'set' && !features.has('set' satisfies ConnectorCloudFeature)) {
      throw new ConnectorActError(
        'cloud_lacks_set',
        "Orca Cloud can't change issues yet. Say what should change instead, and try again after Orca Cloud updates."
      )
    }
    if (args.search && !features.has('find.search' satisfies ConnectorCloudFeature)) {
      throw new ConnectorActError(
        'cloud_lacks_search',
        "Orca Cloud can't search yet. Find a channel by its name or link with `orca slack find`."
      )
    }
    if (
      (args.stage || args.files) &&
      !features.has('reply.files' satisfies ConnectorCloudFeature)
    ) {
      throw new ConnectorActError(
        'cloud_lacks_reply_files',
        "Orca Cloud can't post several files in one reply yet; each file goes as its own message."
      )
    }
    // A file's bytes go straight between the CLI and the source; an older cloud took them inline.
    if (
      (args.upload || args.stream || (verb === 'attach' && args.files)) &&
      !features.has('files.direct' satisfies ConnectorCloudFeature)
    ) {
      throw new ConnectorActError(
        'cloud_lacks_direct_files',
        "Orca Cloud can't take files from this version of Orca yet; nothing was sent. Try again after Orca Cloud updates."
      )
    }
    const signal = context.signal ?? new AbortController().signal
    const target = runtime.getExternalConversationSeam()?.replyTarget(chatPaneKey(sessionId))
    const conversation = target ? cloudConversation(target.key) : null
    const place = verb === 'find' && args.search && !ref ? searchedWorkspace(target?.key) : ref
    // Only a post (its words, or a file and its comment) shows another Orca bot whom its turn acts for.
    const turnFor =
      verb === 'post' || verb === 'reply' || verb === 'attach'
        ? await botTurnFor(
            runtime,
            sessionId,
            sessionCallerOf(context.orchestrationCaller)?.sessionId
          )
        : undefined
    const answer = await postConnectorAction(
      cloud,
      {
        botId: bot.id,
        verb,
        ...(place ? { ref: place } : {}),
        args,
        ...(conversation ? { conversation } : {}),
        ...(conversation && target?.turnId != null ? { turnId: target.turnId } : {}),
        ...(turnFor ? { turnFor } : {})
      },
      signal
    )
    if (!answer.ok) {
      throw actFailure(verb, ref, answer)
    }
    if (verb === 'post' && answer.value.ok) {
      // Before the bot's next command, so a reply right after it knows the answer is already posted.
      await noteBotRequestPost(runtime, sessionId, ref).catch((error: unknown) =>
        console.warn('[bots] could not note a post for a bot request', error)
      )
    }
    // A reply lands in the conversation that woke the run, which the bot names as Orca does.
    return verb === 'reply' && answer.value.ok && target
      ? { ...answer.value, result: { ...answer.value.result, place: target.place } }
      : answer.value
  }
})
