import { replyToFeishu } from './connectors/connector-reply-feishu'
import type { ConnectorCloudFeature } from '../../../../shared/connectors/connector-cloud-contract'
import {
  CONNECTOR_CLOUD_POST_SCHEDULE_FEATURE,
  CONNECTOR_CLOUD_REPLY_CHOICES_FEATURE,
  CONNECTOR_CLOUD_SLACK_TOOLS_FEATURE
} from '../../../../shared/connector-cloud-features'
import type { ConnectorActErrorCode } from '../../../../shared/connector-action-contract'
import { ConnectorAct } from '../../../../shared/rpc-contract/connectors/connector-params'
import { botOfSession } from '../../../bots/bot-session-tabs'
import {
  LOOK_AROUND_REFUSAL,
  lookAroundConnectorVerbAllowed,
  REPLY_ONLY_REFUSAL
} from '../../../bots/bot-look-around-policy'
import { postConnectorAction } from '../../../connector-cloud/connector-actions'
import { actionGoesToSlack, slackActionArgs } from '../../../connector-cloud/connector-slack-text'
import { cloudConversation } from '../../../../shared/connectors/connector-cloud-contract'
import { chatPaneKey } from '../../../external-conversations/external-conversation-chat'
import { defineMethod, type RpcContext } from '../core'
import type { z } from 'zod'
import type { BotActingTurn } from '../../../bots/bot-request-asker'
import { botTurnFor } from '../../../bots/bot-turn-for'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import { noteBotRequestPost } from './orchestration/messaging/bot-request-outcome'
import { connectorPostAttempts } from '../../../external-conversations/connector-post-attempts'
import { orcaSignInServer } from '../../../bots/orca-sign-in-server'
import {
  hostNotSignedIn,
  orcaCloudNeedsSignIn,
  serverSignInSteps,
  type OrcaSignInServer
} from '../../../../shared/bots/host-orca-sign-in'

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

/** The host signed out of Orca, for the bot to relay: a headless server names itself and how it signs in. */
function signedOutError(host: { server: OrcaSignInServer; botName: string }): ConnectorActError {
  const steps = serverSignInSteps(host.server, host.botName, 'bot')
  return new ConnectorActError(
    'connector_not_connected',
    steps
      ? `${hostNotSignedIn(host.server)}, so it can't reach Orca Cloud. ${steps} Then try again.`
      : `${hostNotSignedIn(host.server)}: sign in to Orca Cloud on this computer, then try again.`
  )
}

/** A cloud failure in words; only an answer that never came is "didn't answer". */
export function actFailure(
  verb: string,
  ref: string | undefined,
  failure: { status: number | null; error: string | null; sessionRefused?: true },
  host: { server: OrcaSignInServer; botName: string }
): ConnectorActError {
  // Signed out, or a sign-in the connector-token route still refused after the session refresh.
  if (failure.sessionRefused || (failure.status === 401 && failure.error === 'signed_out')) {
    return signedOutError(host)
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

/** `turn`: the chat's running turn when the caller already read it, so it is not read again. */
export async function actAsBot(
  { sessionId, verb, ref, args }: z.infer<typeof ConnectorAct>,
  context: RpcContext,
  turn?: BotActingTurn
) {
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
  const localTarget = runtime.getExternalConversationSeam()?.replyTarget(chatPaneKey(sessionId))
  if (verb === 'reply' && localTarget?.key.source === 'feishu-local') {
    if (
      !args.text ||
      !args.postId ||
      !args.choices?.length ||
      Object.keys(args).some((key) => !['text', 'postId', 'choices'].includes(key))
    ) {
      throw new ConnectorActError(
        'connector_invalid_request',
        'This Feishu action supports text with choices only.'
      )
    }
    const result = await replyToFeishu(
      { sessionId, replyId: args.postId, text: args.text },
      context,
      localTarget,
      args.choices
    )
    return { ok: true as const, result }
  }
  const cloud = runtime.getConnectorCloud()
  const features = cloud?.cloudFeatures()
  // Signed out, or a sign-in Orca Cloud refused after its hello (features stay cached): say so, and
  // on a headless server how it signs in, before calling a cloud that would refuse it.
  if (cloud && orcaCloudNeedsSignIn(cloud.status())) {
    throw signedOutError({ server: orcaSignInServer(runtime), botName: bot.name })
  }
  if (!cloud || !features) {
    throw new ConnectorActError(
      'connector_not_connected',
      "Orca isn't connected to Orca Cloud: sign in to Orca Cloud and connect a bot to Slack, Linear or GitHub, then try again."
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
  // A titled post is an issue; a canvas or a list is titled too, and needs only Slack's verbs.
  if (verb === 'post' && args.title && !features.has('create' satisfies ConnectorCloudFeature)) {
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
    (verb === 'pin' || verb === 'canvas' || verb === 'list' || verb === 'scheduled') &&
    !features.has(CONNECTOR_CLOUD_SLACK_TOOLS_FEATURE)
  ) {
    throw new ConnectorActError(
      'cloud_lacks_slack_tools',
      "Orca Cloud can't do that in Slack yet; nothing was changed. Try again after Orca Cloud updates."
    )
  }
  if (args.postAt && !features.has(CONNECTOR_CLOUD_POST_SCHEDULE_FEATURE)) {
    throw new ConnectorActError(
      'cloud_lacks_schedule',
      "Orca Cloud can't post later yet; nothing was scheduled. Post it now, or try again after Orca Cloud updates."
    )
  }
  if ((args.stage || args.files) && !features.has('reply.files' satisfies ConnectorCloudFeature)) {
    throw new ConnectorActError(
      'cloud_lacks_reply_files',
      "Orca Cloud can't post several files in one reply yet; each file goes as its own message."
    )
  }
  // An older cloud refuses the field outright; this says what to do instead.
  if (args.choices && !features.has(CONNECTOR_CLOUD_REPLY_CHOICES_FEATURE)) {
    throw new ConnectorActError(
      'cloud_lacks_reply_choices',
      "Orca Cloud can't put buttons on a reply yet; nothing was posted. List the options in --text and ask them to answer in words."
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
  const actsFor = await botTurnFor(
    runtime,
    sessionId,
    sessionCallerOf(context.orchestrationCaller)?.sessionId,
    turn
  )
  // A post (its words, or a file and its comment) shows another Orca bot whom its turn acts for.
  // Any other verb says only owner: the cloud believes a host's other answer over its own record.
  const turnFor =
    verb === 'post' || verb === 'reply' || verb === 'attach' || actsFor === 'owner'
      ? actsFor
      : undefined
  // Asked again here, after the awaits above: a post for later must never go to a cloud that
  // has stopped saying it schedules.
  if (args.postAt && !cloud.cloudFeatures()?.has(CONNECTOR_CLOUD_POST_SCHEDULE_FEATURE)) {
    throw new ConnectorActError(
      'cloud_lacks_schedule',
      "Orca Cloud can't post later yet; nothing was scheduled. Post it now, or try again after Orca Cloud updates."
    )
  }
  const toSlack = actionGoesToSlack({ verb, ref, title: args.title, conversation })
  // Only a post into the thread the chat answers is its own answer; one elsewhere is other work,
  // and a file staged for a later post isn't a post yet.
  const staging = args.upload !== undefined || args.stage === true
  const intoThread =
    !staging &&
    (verb === 'reply' || ((verb === 'post' || verb === 'attach') && !ref && conversation !== null))
  const refused = intoThread
    ? connectorPostAttempts.attempted(chatPaneKey(sessionId), args.postId, target?.key.externalId)
    : () => {}
  const answer = await postConnectorAction(
    cloud,
    {
      botId: bot.id,
      verb,
      ...(place ? { ref: place } : {}),
      args: toSlack ? slackActionArgs(args) : args,
      ...(conversation ? { conversation } : {}),
      ...(conversation && target?.turnId != null ? { turnId: target.turnId } : {}),
      ...(turnFor ? { turnFor } : {})
    },
    signal
  )
  // Refused outright, by the source or the cloud: nothing reached the thread. An uncertain post
  // may have, so it stays counted.
  const certain = answer.ok
    ? !answer.value.ok && answer.value.refusal !== 'post_uncertain'
    : answer.status !== null && answer.status < 500 && answer.error !== 'post_uncertain'
  if (certain) {
    refused()
  }
  if (!answer.ok) {
    throw actFailure(verb, ref, answer, {
      server: orcaSignInServer(runtime),
      botName: bot.name
    })
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

// `orca slack ...`, `orca bot connectors` and `orca bot reply --react`: the calling chat names its bot; the cloud acts as it.
export const CONNECTOR_ACT_METHOD = defineMethod({
  name: 'connector.act',
  permission: 'workspace',
  params: ConnectorAct,
  handler: (params, context) => actAsBot(params, context)
})
