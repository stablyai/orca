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
import { ChatPage, MessagePage, type GraphChat, type GraphMessage } from './teams-graph-shapes'
import { teamsMessageText } from './teams-message-text'
import { formatTeamsRef, parseTeamsPlace } from './teams-place-ref'
import type { TeamsTriggerState } from './teams-trigger-state'

// After a long sleep only the last hour counts; older mentions would wake a bot about stale talk.
const MAX_CATCH_UP_MS = 60 * 60_000
// Graph's clock and this host's differ a little; repeats from the overlap are dropped by key.
const OVERLAP_MS = 2 * 60_000
const CHAT_PAGES = 4
const MESSAGE_PAGES = 3
const RATE_LIMIT_BACKOFF_MS = 60_000
const ERROR_BACKOFF_MS = 5 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000
const MAX_REMEMBERED_FIRES = 500
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

const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN)

/** Chats with a message since `from`, newest first; only `only` when every rule names its chats. */
async function changedChats(
  graph: TeamsGraph,
  from: number,
  only: Set<string> | null
): Promise<GraphChat[]> {
  const changed: GraphChat[] = []
  let next: string | undefined =
    '/me/chats?$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc&$top=50'
  for (let pages = 0; next && pages < CHAT_PAGES; pages++) {
    const page = await graph.get(next, ChatPage)
    const chats = page.value ?? []
    const fresh = chats.filter((chat) => at(chat.lastMessagePreview?.createdDateTime) >= from)
    changed.push(
      ...fresh.filter(
        (chat) => !only || only.has(formatTeamsRef({ kind: 'chat', chatId: chat.id }))
      )
    )
    // Newest first, so a page that ends on an older chat is the last one needed.
    next = fresh.length === chats.length ? page['@odata.nextLink'] : undefined
  }
  return changed
}

async function messagesSince(
  graph: TeamsGraph,
  chatId: string,
  from: number
): Promise<GraphMessage[]> {
  const messages: GraphMessage[] = []
  let next: string | undefined =
    `/chats/${encodeURIComponent(chatId)}/messages?$top=50&$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt ${new Date(from).toISOString()}`
  for (let pages = 0; next && pages < MESSAGE_PAGES; pages++) {
    const page = await graph.get(next, MessagePage)
    messages.push(...(page.value ?? []))
    next = page['@odata.nextLink']
  }
  return messages
}

/** A new message from someone else that @mentions the signed-in person; edits of older ones never count. */
function mentionOf(message: GraphMessage, userId: string, from: number): number | null {
  const created = at(message.createdDateTime)
  const mentioned = (message.mentions ?? []).some((entry) => entry.mentioned?.user?.id === userId)
  return message.messageType === 'message' &&
    !message.deletedDateTime &&
    message.from?.user?.id !== userId &&
    created >= from &&
    mentioned
    ? created
    : null
}

function ruleMatches(rule: AutomationTeamsTrigger, chatRef: string, text: string): boolean {
  return (
    (!rule.in?.length || rule.in.includes(chatRef)) &&
    (!rule.textContains || text.toLowerCase().includes(rule.textContains.toLowerCase()))
  )
}

function runEvent(
  rule: AutomationTeamsTrigger,
  chat: GraphChat,
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
    const graph = this.deps.graph()
    const { userId } = await graph.account()
    if (state.userId !== userId || state.cursor === undefined) {
      state.userId = userId
      state.cursor = now
      return
    }
    if (state.cursor < now - MAX_CATCH_UP_MS) {
      console.warn('[teams] mention check was away over an hour; older mentions are skipped')
    }
    const from = Math.max(state.cursor, now - MAX_CATCH_UP_MS) - OVERLAP_MS
    const only = targets.every((target) => target.rule.in?.length)
      ? new Set(targets.flatMap((target) => target.rule.in ?? []))
      : null
    let started = true
    for (const chat of await changedChats(graph, from, only)) {
      const chatRef = formatTeamsRef({ kind: 'chat', chatId: chat.id })
      const messages = await messagesSince(graph, chat.id, from)
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
            started = (await this.fire(target, event)) && started
          }
        }
      }
    }
    // Moves only once every match is handed over, so a failed start is retried next check.
    if (started) {
      state.cursor = now
    }
  }

  /** False when the run path failed, so the cursor stays and the next check retries. */
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
