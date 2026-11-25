// The check behind bots' teams.mentioned rules. Slack's mentions reach a bot through Orca Cloud; Teams
// has no such route, and Graph's change notifications need a public HTTPS endpoint, so the host that
// holds the Teams sign-in polls Graph on its automation tick (about a minute), only while a rule
// listens. Each match goes to the same event path the cloud's deliveries take, which drops repeats.
import {
  MAX_AUTOMATION_EVENT_TEXT_LENGTH,
  type AutomationRunEvent
} from '../../shared/automation-event-triggers'
import { isTeamsTrigger, type AutomationTeamsTrigger } from '../../shared/automation-teams-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import { TeamsNotConnectedError } from './teams-account-tokens'
import { TeamsGraphError, type TeamsGraph } from './teams-graph'
import type { GraphChat, GraphMessage } from './teams-graph-shapes'
import {
  CHATS_BY_LAST_MESSAGE,
  changedChats,
  chatReadFailed,
  mentionOf,
  messagesIn,
  type ChatWindow
} from './teams-mention-reads'
import { teamsMessageText } from './teams-message-text'
import { formatTeamsRef, parseTeamsPlace } from './teams-place-ref'
import type { TeamsTriggerState } from './teams-trigger-state'

// After a long sleep only the last hour counts; older mentions would wake a bot about stale talk.
const MAX_CATCH_UP_MS = 60 * 60_000
// Graph's clock and this host's differ a little; repeats from the overlap are dropped by key.
const OVERLAP_MS = 2 * 60_000
// Chats left to read again, read a few per check after the new window.
const BACKLOG_CHATS_PER_CHECK = 5
const RATE_LIMIT_BACKOFF_MS = 60_000
const ERROR_BACKOFF_MS = 5 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000
const MAX_REMEMBERED_FIRES = 500
// Chat-list pages left to read; one is read per check, oldest first.
const MAX_CHAT_PAGES_KEPT = 4
const TEAMS_LINK = /^https:\/\/(teams\.microsoft\.com|teams\.cloud\.microsoft)\//

type Target = { automationId: string; botId: string; rule: AutomationTeamsTrigger }

export type TeamsTriggerCheckerDeps = {
  automations(): readonly Pick<Automation, 'id' | 'enabled' | 'bot' | 'on'>[]
  bots(): readonly Pick<Bot, 'id' | 'teams'>[]
  graph(): TeamsGraph
  runForEvent(automationId: string, event: AutomationRunEvent): Promise<unknown>
  readState(): Promise<TeamsTriggerState>
  writeState(state: TeamsTriggerState): Promise<void>
  now(): number
}

function teamsRuleTargets(
  automations: ReturnType<TeamsTriggerCheckerDeps['automations']>,
  bots: ReturnType<TeamsTriggerCheckerDeps['bots']>
): Target[] {
  return automations.flatMap((automation) => {
    const botId = automation.bot?.botId
    if (!automation.enabled || !botId || !teamsOn(bots, botId)) {
      return []
    }
    return (automation.on ?? [])
      .filter(isTeamsTrigger)
      .map((rule) => ({ automationId: automation.id, botId, rule }))
  })
}

const teamsOn = (bots: ReturnType<TeamsTriggerCheckerDeps['bots']>, botId: string) =>
  bots.find((bot) => bot.id === botId)?.teams === true

function ruleMatches(rule: AutomationTeamsTrigger, chatRef: string, text: string): boolean {
  return (
    (!rule.in?.length || rule.in.includes(chatRef)) &&
    (!rule.textContains || text.toLowerCase().includes(rule.textContains.toLowerCase()))
  )
}

function runEvent(
  rule: AutomationTeamsTrigger,
  chat: Pick<GraphChat, 'id' | 'topic'>,
  message: GraphMessage,
  ref: string,
  occurredAt: number,
  text: string
): AutomationRunEvent {
  const actor = message.from?.user?.displayName?.trim()
  return {
    triggerId: rule.id,
    source: 'teams',
    event: 'mentioned',
    key: ref,
    // Later mentions in the chat fold into its unfinished run.
    subject: formatTeamsRef({ kind: 'chat', chatId: chat.id }),
    occurredAt,
    ...(actor ? { actor } : {}),
    place: chat.topic?.trim() || 'a Teams chat',
    ...(message.webUrl && TEAMS_LINK.test(message.webUrl) ? { url: message.webUrl } : {}),
    text: text.slice(0, MAX_AUTOMATION_EVENT_TEXT_LENGTH),
    teams: { ref }
  }
}

export class TeamsTriggerChecker {
  private checking = false
  private stopped = false
  private backoff: { until: number; failures: number } | null = null
  private readonly fired = new Set<string>()

  constructor(private readonly deps: TeamsTriggerCheckerDeps) {}

  /** One check, unless the last is still running. */
  tick(): Promise<void> {
    if (this.checking || this.stopped) {
      return Promise.resolve()
    }
    this.checking = true
    return this.check()
      .catch((error: unknown) => console.warn('[teams] mention check failed', error))
      .finally(() => {
        this.checking = false
      })
  }

  stop(): void {
    this.stopped = true
  }

  private async check(): Promise<void> {
    const targets = teamsRuleTargets(this.deps.automations(), this.deps.bots())
    const state = await this.deps.readState()
    const before = JSON.stringify(state)
    const now = this.deps.now()
    const listening = new Set(targets.map((target) => target.botId))
    for (const botId of listening) {
      state.listeners[botId] ??= now
    }
    for (const botId of Object.keys(state.listeners)) {
      if (!listening.has(botId)) {
        delete state.listeners[botId]
      }
    }
    // Nothing listens, so nothing is read; the next rule starts from then.
    if (targets.length === 0) {
      delete state.cursor
    } else if (!this.backoff || now >= this.backoff.until) {
      await this.guarded(() => this.checkChats(targets, state, now))
    }
    if (JSON.stringify(state) !== before) {
      await this.deps.writeState(state)
    }
  }

  private async guarded(check: () => Promise<void>): Promise<void> {
    try {
      await check()
      this.backoff = null
    } catch (error) {
      const failures = (this.backoff?.failures ?? 0) + 1
      const limited = error instanceof TeamsGraphError && error.status === 429
      const base = limited ? RATE_LIMIT_BACKOFF_MS : ERROR_BACKOFF_MS
      this.backoff = {
        failures,
        until: this.deps.now() + Math.min(base * 2 ** (failures - 1), MAX_BACKOFF_MS)
      }
      if (failures === 1) {
        const why = error instanceof TeamsNotConnectedError ? error.message : error
        console.warn('[teams] mention check failed; backing off', why)
      }
    }
  }

  private async checkChats(
    targets: Target[],
    state: TeamsTriggerState,
    now: number
  ): Promise<void> {
    const signedIn = this.deps.graph()
    const { userId } = await signedIn.account()
    // Every read is as the person whose mentions are matched; a sign-in that changes mid-check fails it.
    const graph: TeamsGraph = {
      ...signedIn,
      get: (pathOrLink, shape) => signedIn.get(pathOrLink, shape, userId)
    }
    if (state.userId !== userId || state.cursor === undefined) {
      state.userId = userId
      state.cursor = now
      // The next read overlaps the time before now; no bot counts a message from then.
      for (const botId of Object.keys(state.listeners)) {
        state.listeners[botId] = now
      }
      delete state.backlog
      delete state.chatsNext
      return
    }
    if (state.cursor < now - MAX_CATCH_UP_MS) {
      console.warn('[teams] mention check was away over an hour; older mentions are skipped')
    }
    const floor = now - MAX_CATCH_UP_MS - OVERLAP_MS
    const from = Math.max(state.cursor, now - MAX_CATCH_UP_MS) - OVERLAP_MS
    const only = targets.every((target) => target.rule.in?.length)
      ? new Set(targets.flatMap((target) => target.rule.in ?? []))
      : null
    // Built aside and saved only once every read succeeded, so a failed check loses nothing.
    const listed: { chat: Pick<GraphChat, 'id' | 'topic'>; window: ChatWindow }[] = []
    const [resumed, ...chatsNext] = (state.chatsNext ?? []).filter((page) => page.from >= floor)
    if (resumed) {
      const page = await changedChats(graph, resumed.link, resumed.from, only)
      listed.push(...page.chats.map((chat) => ({ chat, window: { from: resumed.from } })))
      if (page.next) {
        chatsNext.unshift({ link: page.next, from: resumed.from })
      }
    }
    const fresh = await changedChats(graph, CHATS_BY_LAST_MESSAGE, from, only)
    listed.push(...fresh.chats.map((chat) => ({ chat, window: { from } })))
    if (fresh.next) {
      chatsNext.push({ link: fresh.next, from })
    }
    if (chatsNext.length > MAX_CHAT_PAGES_KEPT) {
      console.warn(
        '[teams] over 200 chats changed in each of several checks; the oldest are skipped'
      )
      chatsNext.splice(0, chatsNext.length - MAX_CHAT_PAGES_KEPT)
    }
    const backlog: NonNullable<TeamsTriggerState['backlog']> = {}
    const keep = (chat: Pick<GraphChat, 'id' | 'topic'>, rest: Required<ChatWindow>) => {
      const had = backlog[chat.id]
      backlog[chat.id] = {
        from: Math.min(had?.from ?? rest.from, rest.from),
        until: Math.max(had?.until ?? rest.until, rest.until),
        topic: chat.topic ?? null
      }
    }
    const pending = Object.entries(state.backlog ?? {})
      .filter(([, window]) => window.until > floor)
      .map(([id, window]) => ({
        chat: { id, topic: window.topic },
        window: { from: Math.max(window.from, floor), until: window.until }
      }))
    for (const { chat, window } of [...listed, ...pending.slice(0, BACKLOG_CHATS_PER_CHECK)]) {
      const read = await messagesIn(graph, chat.id, window).catch((error: unknown) =>
        chatReadFailed(error, chat.id)
      )
      if (!read) {
        // Not there for this sign-in any more: its window goes.
        continue
      }
      if (read === 'retry') {
        keep(chat, { from: window.from, until: window.until ?? now + 1 })
        continue
      }
      if (read.rest) {
        keep(chat, read.rest)
      }
      // A match the run path didn't take keeps its window, so the next check offers it again.
      if (
        !(await this.fireMatches(targets, state, chat, read.messages, userId, window.from, now))
      ) {
        keep(chat, { from: window.from, until: window.until ?? now + 1 })
      }
    }
    for (const { chat, window } of pending.slice(BACKLOG_CHATS_PER_CHECK)) {
      keep(chat, window)
    }
    state.cursor = now
    if (Object.keys(backlog).length > 0) {
      state.backlog = backlog
    } else {
      delete state.backlog
    }
    if (chatsNext.length > 0) {
      state.chatsNext = chatsNext
    } else {
      delete state.chatsNext
    }
  }

  /** False when any match wasn't handed to the run path. */
  private async fireMatches(
    targets: Target[],
    state: TeamsTriggerState,
    chat: Pick<GraphChat, 'id' | 'topic'>,
    messages: GraphMessage[],
    userId: string,
    from: number,
    now: number
  ): Promise<boolean> {
    const chatRef = formatTeamsRef({ kind: 'chat', chatId: chat.id })
    let handed = true
    for (const message of messages.toReversed()) {
      const occurredAt = mentionOf(message, userId, from)
      const place = parseTeamsPlace(`${chatRef}/${message.id}`)
      if (occurredAt === null || !place) {
        continue
      }
      const ref = formatTeamsRef(place)
      const text = teamsMessageText(message.body, message.attachments ?? [])
      for (const target of targets) {
        const since = state.listeners[target.botId] ?? now
        if (occurredAt >= since && ruleMatches(target.rule, chatRef, text)) {
          const event = runEvent(target.rule, chat, message, ref, occurredAt, text)
          handed = (await this.fire(target, event)) && handed
        }
      }
    }
    return handed
  }

  /**
   * False when the hand-off to the run path threw, so the next check offers the match again. A run
   * that is created but fails to launch is the run path's to record, as for Gmail and Calendar.
   */
  private async fire(target: Target, event: AutomationRunEvent): Promise<boolean> {
    const id = `${target.automationId} ${event.key}`
    if (this.fired.has(id) || !teamsOn(this.deps.bots(), target.botId)) {
      return true
    }
    this.fired.add(id)
    if (this.fired.size > MAX_REMEMBERED_FIRES) {
      this.fired.delete(this.fired.values().next().value ?? '')
    }
    try {
      await this.deps.runForEvent(target.automationId, event)
      return true
    } catch (error) {
      this.fired.delete(id)
      console.warn('[teams] could not start an automation run', error)
      return false
    }
  }
}
