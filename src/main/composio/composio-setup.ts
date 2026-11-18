// Composio setup in a bot's chat. The owner starts it from Add connector; the bot explains and asks
// Orca for the card it needs; the owner's clicks reach the bot as hidden card answers, never bubbles.
import {
  composioUserOfBot,
  type ComposioAppSignIn,
  type ComposioConnection
} from '../../shared/composio/composio-apps'
import type {
  ComposioSetupApp,
  ComposioSetupCardRef
} from '../../shared/composio/composio-setup-card'
import type { COMPOSIO_SETUP_STARTED_FROM } from '../../shared/rpc-contract/bots-composio-params'
import type { ComposioBots } from './composio-bots'

export type ComposioSetupStartedFrom = (typeof COMPOSIO_SETUP_STARTED_FROM)[number]

const FROM_LABEL: Record<ComposioSetupStartedFrom, string> = {
  'add-connector': 'Add connector',
  tools: 'Tools'
}

export type ComposioSetupChat = {
  botName: (botId: string) => string
  /** Tells the bot, with nothing drawn in the chat; returns the chat it went to. */
  tellBot: (botId: string, line: string) => Promise<{ sessionId: string }>
  /** The bot's chat, if it has one. */
  chatOf: (botId: string) => string | undefined
  /** An Orca status line, or a setup card, in a chat. */
  write: (sessionId: string | undefined, item: ComposioSetupCardRef | string) => void
}

/** What the bot hears about the app's Connect card, from how the app signs in. */
function connectNote(app: ComposioSetupApp, signIn: ComposioAppSignIn): string {
  switch (signIn) {
    case 'none':
      return `${app.name} needs no sign-in; it's ready through your Composio tool.`
    case 'key':
      return `Your owner enters their ${app.name} API key on Composio's page, opened from the card. You hear when they finish.`
    case 'own':
      return ownSetUpNote(app)
    case 'composio':
      return `Your owner signs in to ${app.name} on the card. You hear when they finish.`
  }
}

const ownSetUpNote = (app: ComposioSetupApp) =>
  `${app.name} needs a one-time setup in Composio before anyone can sign in: your owner adds their own ${app.name} developer app under Composio's Auth Configs. The card walks them through it; you hear when they connect.`

const appLabel = (app: ComposioSetupApp) => `${app.name} (${app.slug})`

/** The line the bot reads when its owner starts a setup. */
export function composioSetupStartLine(
  from: ComposioSetupStartedFrom,
  app: ComposioSetupApp | undefined
): string {
  const what = app ? `for ${appLabel(app)}` : 'with no app picked'
  const next = app
    ? `Run \`orca skills get orca-cli --reference composio\`, then set it up as it says, with \`orca bot composio setup --app ${app.slug}\`.`
    : 'Run `orca skills get orca-cli --reference composio`, then set it up as it says; ask which app first.'
  return `Composio setup started by your owner from ${FROM_LABEL[from]}, ${what}. ${next}`
}

export function composioSetupAnswerLine(card: string, answer: string): string {
  return `Card composio-setup/${card} answered: ${answer}`
}

const ALREADY_SHOWN = 'That card is already in the chat. '

// By reason too: a Connect the bot asks for while an expiry's card is up is its own card, and reports.
const cardKey = (ref: ComposioSetupCardRef) =>
  `${ref.card}:${ref.app?.slug ?? ''}:${ref.hookId ?? ''}:${ref.trigger?.slug ?? ''}:${ref.reason ?? ''}`

export class ComposioSetup {
  /** Each bot's last card, so asking again doesn't stack a second copy under the live one. */
  private readonly lastCard = new Map<string, string>()

  constructor(
    private readonly composio: Pick<
      ComposioBots,
      'keyState' | 'connections' | 'app' | 'ensureTool'
    >,
    private readonly chat: ComposioSetupChat
  ) {}

  /** Owner: writes the "started from" line and hands the bot the setup. */
  async start(
    botId: string,
    from: ComposioSetupStartedFrom,
    app?: ComposioSetupApp
  ): Promise<void> {
    this.lastCard.delete(botId)
    await this.chat.tellBot(botId, composioSetupStartLine(from, app))
  }

  /**
   * Bot: writes the card the setup needs next. The key first; then the app's Connect; or, with the
   * app already connected, what the bot can use. Returns what it wrote, for the bot to read.
   */
  async card(
    botId: string,
    app?: ComposioSetupApp,
    step?: ComposioSetupCardRef['step']
  ): Promise<{ card: ComposioSetupCardRef | null; message: string }> {
    const sessionId = this.chat.chatOf(botId)
    const key = this.composio.keyState()
    if (key !== 'ok') {
      const card: ComposioSetupCardRef = {
        botId,
        card: 'key',
        ...(app ? { app, step: { index: 1, total: 2 } } : {})
      }
      const shown = this.writeCard(sessionId, card)
      return {
        card,
        message:
          (shown ? '' : ALREADY_SHOWN) +
          (key === 'rejected'
            ? 'Composio no longer accepts the saved key. Your owner adds a new one on the card.'
            : 'Your owner adds their Composio key on the card. You hear when they do.')
      }
    }
    if (!app) {
      return {
        card: null,
        message: `The Composio key is set; your Composio user is ${composioUserOfBot(botId)}. Name the app with --app <slug>.`
      }
    }
    const signIn = await this.signInOf(app)
    if (signIn === 'none') {
      // Nothing to sign in to: the app is ready once the bot has its Composio tool.
      await this.composio.ensureTool(botId)
    }
    const connected = signIn === 'none' ? null : await this.connectedApp(botId, app.slug)
    const card: ComposioSetupCardRef =
      connected || signIn === 'none'
        ? { botId, card: 'ready', app }
        : { botId, card: 'connect', app, ...(step ? { step } : {}) }
    const shown = this.writeCard(sessionId, card)
    return {
      card,
      message:
        (shown ? '' : ALREADY_SHOWN) +
        (connected
          ? `${app.name} is already connected${connected.label ? ` as ${connected.label}` : ''}. Use it through your Composio tool.`
          : connectNote(app, signIn))
    }
  }

  /** Owner: the key card's key was saved, from its dialog. */
  async keyAdded(botId: string, app?: ComposioSetupApp): Promise<void> {
    const sessionId = this.chat.chatOf(botId)
    this.chat.write(
      sessionId,
      `Composio key added · Composio apps are now in ${this.chat.botName(botId)}'s Tools`
    )
    if (!app) {
      await this.chat.tellBot(botId, composioSetupAnswerLine('key', 'added'))
      return
    }
    // The app's next card, as the bot would ask for it, then what it shows.
    this.lastCard.delete(botId)
    const next = await this.card(botId, app, { index: 2, total: 2 })
    await this.chat.tellBot(
      botId,
      composioSetupAnswerLine(
        'key',
        `added; Orca shows the ${next.card?.card ?? 'connect'} ${app.slug} card. ${next.message}`
      )
    )
  }

  /** Owner: Not now on the key card. */
  async keyDeclined(botId: string): Promise<void> {
    await this.chat.tellBot(botId, composioSetupAnswerLine('key', 'not now'))
  }

  /** A Connect a card started ended: the connected line and Ready card, and the bot hears unless the
   *  card was an expiry's, which nobody asked the bot for. */
  async connectEnded(
    botId: string,
    app: ComposioSetupApp,
    connection: ComposioConnection | null,
    reason?: 'expired'
  ): Promise<void> {
    const slug = app.slug
    const quiet = reason === 'expired'
    if (!connection) {
      if (!quiet) {
        await this.chat.tellBot(
          botId,
          composioSetupAnswerLine('connect', `${slug} not connected; the sign-in didn't finish`)
        )
      }
      return
    }
    const sessionId = this.chat.chatOf(botId)
    const as = connection.label ? ` as ${connection.label}` : ''
    this.chat.write(sessionId, `${app.name} connected${as}`)
    this.writeCard(sessionId, { botId, card: 'ready', app })
    if (!quiet) {
      await this.chat.tellBot(botId, composioSetupAnswerLine('connect', `${slug} connected${as}`))
    }
  }

  /** Bot: the card that sends a Composio trigger's events to one of its webhooks. */
  eventsCard(
    botId: string,
    hookId: string,
    trigger: NonNullable<ComposioSetupCardRef['trigger']>,
    /** The where= Orca just added to the hook's automation, so it takes only this bot's events. */
    addedFilter?: string
  ): { message: string } {
    const added = addedFilter
      ? ` Orca added ${addedFilter} to the automation's filter, so it takes only your events, not your owner's other bots'.`
      : ''
    const shown = this.writeCard(this.chat.chatOf(botId), {
      botId,
      card: 'events',
      hookId,
      trigger
    })
    return {
      message: `${shown ? '' : ALREADY_SHOWN}Your owner sets up ${trigger.name} on the card. You hear when it's done, or when they'd rather do it by hand.${added}`
    }
  }

  /** Owner: the events card set everything up. */
  async eventsSetUp(botId: string, hookId: string, triggerName: string): Promise<void> {
    this.chat.write(this.chat.chatOf(botId), `Composio events set up · ${triggerName} is on`)
    await this.chat.tellBot(
      botId,
      composioSetupAnswerLine(
        'events',
        `set up; ${triggerName} is on and its calls go to hook ${hookId}`
      )
    )
  }

  /** Composio said one of the bot's sign-ins expired: the line and the Connect card to reconnect, for
   *  the owner only; the bot learns it when a call fails. */
  signInExpired(botId: string, app: ComposioSetupApp): void {
    const sessionId = this.chat.chatOf(botId)
    this.chat.write(sessionId, `${app.name} sign-in expired · reconnect to keep using it`)
    this.lastCard.delete(botId)
    this.writeCard(sessionId, { botId, card: 'connect', app, reason: 'expired' })
  }

  /** Owner: they'd rather do it in Composio's dashboard. */
  async eventsByHand(botId: string, ingressHookId: string): Promise<void> {
    await this.chat.tellBot(
      botId,
      composioSetupAnswerLine(
        'events',
        `by hand; the card gives them the address (hook ${ingressHookId}) and the steps, and you hear when they choose Done`
      )
    )
  }

  /** Writes a card unless it is the bot's last one; true when written. */
  private writeCard(sessionId: string | undefined, ref: ComposioSetupCardRef): boolean {
    if (this.lastCard.get(ref.botId) === cardKey(ref)) {
      return false
    }
    this.lastCard.set(ref.botId, cardKey(ref))
    this.chat.write(sessionId, ref)
    return true
  }

  /** How the app signs in now; unread, the card offers a plain Connect. */
  private async signInOf(app: ComposioSetupApp): Promise<ComposioAppSignIn> {
    return (await this.composio.app(app.slug).catch(() => null))?.signIn ?? 'composio'
  }

  private async connectedApp(botId: string, slug: string): Promise<ComposioConnection | null> {
    const { connections } = await this.composio.connections(botId)
    return connections.find((entry) => entry.app === slug && entry.status === 'active') ?? null
  }
}
