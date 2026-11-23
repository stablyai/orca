// `bots.googleSetup.*`: a bot's Google setup run. The bot moves it from its chat; the owner's setup
// cards read it and answer it. An answer reaches the bot as a hidden card-answer turn, never a bubble.
import {
  GoogleSetupAnswer,
  GoogleSetupRead,
  GoogleSetupStart,
  GoogleSetupWrite
} from '../../../../shared/rpc-contract/google-setup-params'
import type { GoogleSetupCard, GoogleSetupRun } from '../../../../shared/google/google-setup-run'
import type { GoogleStatusView } from '../../../../shared/google/google-connect-types'
import {
  googleSetupBlocker,
  googleSetupDoneRefusal,
  googleSetupKeyBlocker
} from '../../../../shared/google/google-setup-blocker'
import { googleBotAsk } from '../../../../shared/google/google-bot-connect-state'
import { botTurns } from '../../../bots/bot-automation-sessions'
import { hostGoogleBotState } from '../../../bots/bot-google-access'
import { getGoogleConnect } from '../../../google/google-connect'
import { BOT_TOKEN_ENDED, botOfToken } from '../../../bots/bot-of-caller'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import {
  rewriteGoogleSetupWaitingCard,
  writeGoogleSetupCards
} from '../../../google/google-setup-chat-cards'
import {
  GoogleSetupError,
  googleSetupRuns,
  type GoogleSetupActor,
  type GoogleSetupChange
} from '../../../google/google-setup-runs'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { googleSetupKeyRefusedLine } from '../../../google/google-setup-key-download'
import { noWindowAnswersGoogleCards } from '../../../google/google-card-reach'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { requireSetupPageInAgentWorkspace } from '../../../google/google-setup-page-binding'
import { postConnectorOffer } from './bots-connector-offer'
import { isAgentRpcCaller } from '../callers/rpc-caller-identity'

/** The line the bot reads for an owner's card answer. */
export function googleSetupAnswerLine(card: GoogleSetupCard, values: readonly string[]): string {
  return `Card google-setup/${card} answered: ${values.join(', ')}`
}

/** The line the bot reads when its owner starts a setup from Orca. */
export function googleSetupStartLine(from: string): string {
  return `Google setup started by your owner (from ${from}). Run \`orca bot google-setup show\` and carry on from there.`
}

/** The run's bot, named by its run's token, and who is asking. A bot reaches only its own; anything a
 *  CLI sends counts as a bot, since an agent can leave its token off. */
export function whose(
  params: { botToken?: string; callerSessionId?: string; botId?: string },
  context: RpcContext
): { botId: string; actor: GoogleSetupActor } {
  const { runtime } = context
  runtime.bots.assertEnabled()
  if (params.callerSessionId && runtime.lookAround.botOfLook(params.callerSessionId)) {
    throw new InvalidArgumentError(LOOK_AROUND_REFUSAL)
  }
  const caller = botOfToken(runtime, params.botToken, context.pairedDeviceId)
  if (caller.kind === 'ended') {
    throw new InvalidArgumentError(BOT_TOKEN_ENDED)
  }
  if (caller.kind === 'bot') {
    const { bot } = caller
    if (params.botId && params.botId !== bot.id) {
      throw new InvalidArgumentError('A bot can only work on its own Google setup.')
    }
    return { botId: bot.id, actor: 'bot' }
  }
  if (!params.botId) {
    throw new InvalidArgumentError("Run this from a bot's chat, or name the bot.")
  }
  if (!runtime.bots.list().some((entry) => entry.id === params.botId)) {
    throw new InvalidArgumentError('No such bot.')
  }
  return { botId: params.botId, actor: isAgentRpcCaller(context.caller) ? 'bot' : 'owner' }
}

/** Applies a change and returns the run before and after it, for the cards it calls for. */
function applied(
  botId: string,
  actor: GoogleSetupActor,
  change: GoogleSetupChange
): { prev: GoogleSetupRun | null; run: GoogleSetupRun } {
  const prev = googleSetupRuns().get(botId)
  try {
    return { prev, run: googleSetupRuns().apply(botId, actor, change) }
  } catch (error) {
    if (error instanceof GoogleSetupError) {
      throw new InvalidArgumentError(error.message)
    }
    throw error
  }
}

function chatOf(runtime: OrcaRuntimeService, botId: string): string | undefined {
  return runtime.bots.list().find((entry) => entry.id === botId)?.chatSessionId ?? undefined
}

/** A card answer: the run changes, the cards follow, and the bot reads it as its next turn. */
export async function answerGoogleSetupCard(
  runtime: OrcaRuntimeService,
  botId: string,
  actor: GoogleSetupActor,
  card: GoogleSetupCard,
  values: string[]
): Promise<GoogleSetupRun> {
  const { prev, run } = applied(botId, actor, { action: 'answer', card, values })
  const written = writeGoogleSetupCards(chatOf(runtime, botId), prev, run)
  // The services card now asks the owner; their answer to it wakes the bot, so it can't start early.
  if (written.some((ref) => ref.card === 'services')) {
    return run
  }
  await runtimeBotChats(runtime).sendToChat(
    botId,
    googleSetupAnswerLine(card, values),
    'card-answer'
  )
  return run
}

/** This host's saved key and accounts, or null when Google isn't available here. */
async function hostGoogle(): Promise<Pick<
  GoogleStatusView,
  'client' | 'accounts' | 'clientKey'
> | null> {
  const connect = getGoogleConnect()
  if (!connect) {
    return null
  }
  const clientKey = await connect.clientCheck()
  return {
    client: await connect.client(),
    accounts: await connect.accounts(),
    ...(clientKey ? { clientKey } : {})
  }
}

/** Whether the setup's key isn't in Orca; no Google here means no key. */
function keyMissing(run: GoogleSetupRun, google: Awaited<ReturnType<typeof hostGoogle>>): boolean {
  return !google || googleSetupKeyBlocker(run, google) !== null
}

/** The run with where it's stuck and the owner's buttons, from this host's Google and the bot's turn. */
export async function withBlocker(context: RpcContext, botId: string, run: GoogleSetupRun | null) {
  const google = await hostGoogle()
  const chat = chatOf(context.runtime, botId)
  const blocker = googleSetupBlocker({
    run,
    google,
    botTurnRunning: chat ? botTurns.running(chat) : null,
    now: Date.now()
  })
  // While client is open, so the bot sees a missed download before it marks the step done.
  const client = run?.steps.client?.status
  const open = run?.state === 'running' && (client === 'active' || client === 'needs-user')
  return { run, blocker, keyMissing: open && keyMissing(run, google) }
}

/** The bot marks client done only once the key reached Orca, so a missed download shows at once. */
async function refuseClientDoneWithoutKey(
  botId: string,
  run: GoogleSetupRun | null,
  change: GoogleSetupChange
): Promise<void> {
  if (change.action !== 'step' || change.step !== 'client' || change.status !== 'done' || !run) {
    return
  }
  if (keyMissing(run, await hostGoogle())) {
    // The bot is past Download JSON: the key went missing, so the owner's card offers the recovery.
    // Once: a bot asking again must not make a new change (and a new card) each time.
    if (!run.keyMissed) {
      googleSetupRuns().apply(botId, 'owner', { action: 'key-missed' })
    }
    throw new InvalidArgumentError(
      "Orca doesn't have this setup's key, so client isn't done. Your owner's card shows: Make a new key · Import a key file."
    )
  }
}

/** Orca's reading that the key didn't arrive: the owner's card offers recovery, and the bot hears why. */
export async function recordGoogleSetupKeyMissed(
  runtime: OrcaRuntimeService,
  botId: string,
  reason: string
): Promise<void> {
  const { prev, run } = applied(botId, 'owner', { action: 'key-missed', reason })
  writeGoogleSetupCards(chatOf(runtime, botId), prev, run)
  await runtimeBotChats(runtime).sendToChat(botId, googleSetupKeyRefusedLine(reason), 'card-answer')
}

/** A bot's `done` stands only once Google answers for every chosen service. */
async function refuseUnfinishedDone(run: GoogleSetupRun | null): Promise<void> {
  if (run?.state !== 'running') {
    return
  }
  const connect = getGoogleConnect()
  if (!connect) {
    throw new InvalidArgumentError("Google isn't available on this computer.")
  }
  // A fresh read, so a box ticked on a second sign-in counts; the saved one when Google can't be reached.
  const [accounts, clientKey] = await Promise.all([
    connect.checkAccounts().catch(() => connect.accounts()),
    connect.checkClient()
  ])
  const refusal = googleSetupDoneRefusal(run, {
    client: await connect.client(),
    accounts,
    ...(clientKey ? { clientKey } : {})
  })
  if (refusal) {
    throw new InvalidArgumentError(`${refusal} Run done again once it's sorted.`)
  }
}

/** A bot's start when Google's app is already on this host: its Connect card, or a line, instead of a
 *  setup; `routed` names which. Null runs the setup: no app here yet, or one already running resumes. */
export type GoogleSetupStartRouted = { routed: 'offer' | 'on' | 'server'; message: string }

async function routeBotStart(
  context: RpcContext,
  botId: string,
  callerSessionId: string | undefined
): Promise<GoogleSetupStartRouted | null> {
  const bot = context.runtime.bots.list().find((entry) => entry.id === botId)
  if (!bot || googleSetupRuns().get(botId)?.state === 'running') {
    return null
  }
  const state = await hostGoogleBotState(bot)
  if (state.host === 'no-app') {
    return null
  }
  const ask = googleBotAsk(state, {
    from: 'start',
    headless: noWindowAnswersGoogleCards(context.runtime),
    botName: bot.name
  })
  if (ask.kind === 'card') {
    // The chat it ran from only when that is this bot's; the session id names, it never authorizes.
    const sessionId =
      callerSessionId && botOfSession(context.runtime.bots, callerSessionId)?.id === botId
        ? callerSessionId
        : chatOf(context.runtime, botId)
    if (!sessionId) {
      throw new InvalidArgumentError("Run this from a bot's chat.")
    }
    await postConnectorOffer(sessionId, bot, { botId, source: 'google' }, context.runtime)
  }
  return { routed: ask.kind === 'card' ? 'offer' : ask.kind, message: ask.message }
}

export const GOOGLE_SETUP_METHODS = [
  defineMethod({
    name: 'bots.googleSetup.read',
    permission: 'workspace',
    params: GoogleSetupRead,
    handler: (params, context) => {
      const { botId } = whose(params, context)
      return withBlocker(context, botId, googleSetupRuns().get(botId))
    }
  }),
  defineMethod({
    name: 'bots.googleSetup.write',
    permission: 'workspace',
    params: GoogleSetupWrite,
    handler: async (params, context) => {
      const { botId, actor } = whose(params, context)
      if (actor === 'bot' && params.change.action === 'start' && !params.change.newApp) {
        const routed = await routeBotStart(context, botId, params.callerSessionId)
        if (routed) {
          return routed
        }
      }
      if (actor === 'bot') {
        try {
          if (params.change.action === 'done') {
            await refuseUnfinishedDone(googleSetupRuns().get(botId))
          }
          await refuseClientDoneWithoutKey(botId, googleSetupRuns().get(botId), params.change)
        } catch (error) {
          // Refused for want of the owner: their card goes back to the bottom of the chat.
          const run = googleSetupRuns().get(botId)
          if (run) {
            rewriteGoogleSetupWaitingCard(chatOf(context.runtime, botId), run)
          }
          throw error
        }
      }
      requireSetupPageInAgentWorkspace(context.runtime, botId, params.change)
      const { prev, run } = applied(botId, actor, params.change)
      writeGoogleSetupCards(chatOf(context.runtime, botId), prev, run)
      return withBlocker(context, botId, run)
    }
  }),
  defineMethod({
    name: 'bots.googleSetup.answer',
    permission: 'workspace',
    params: GoogleSetupAnswer,
    handler: async ({ botId, card, values }, context) => {
      // Card buttons run in the owner's Orca; an agent's CLI never answers for them.
      if (isAgentRpcCaller(context.caller)) {
        throw new InvalidArgumentError('Only your owner answers setup cards, in Orca.')
      }
      const { actor } = whose({ botId }, context)
      const run = await answerGoogleSetupCard(context.runtime, botId, actor, card, values)
      // With where it's stuck now, so the card never pairs this run with the last one's buttons.
      return withBlocker(context, botId, run)
    }
  }),
  defineMethod({
    name: 'bots.googleSetup.start',
    permission: 'workspace',
    params: GoogleSetupStart,
    handler: async ({ botId, from }, context) => {
      // Set up Google is a button in the owner's Orca; a bot starts its own run with the CLI.
      if (isAgentRpcCaller(context.caller)) {
        throw new InvalidArgumentError('Only your owner starts Google setup from Orca.')
      }
      const { actor } = whose({ botId }, context)
      const current = googleSetupRuns().get(botId)
      // Pressing it again goes back to the setup already running, rather than starting over.
      if (current?.state === 'running') {
        return { run: current }
      }
      // The person clicks until the owner answers the path card.
      const { prev, run } = applied(botId, actor, { action: 'start', mode: 'unchosen' })
      const { sessionId } = await runtimeBotChats(context.runtime).sendToChat(
        botId,
        googleSetupStartLine(from),
        'card-answer'
      )
      writeGoogleSetupCards(sessionId, prev, run)
      return { run }
    }
  })
]
