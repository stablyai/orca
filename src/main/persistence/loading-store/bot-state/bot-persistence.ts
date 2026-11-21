import { splitBotsByOlderBuildSupport, type Bot } from '../../../../shared/bot-types'
import type { StoreRuntimeState } from '../store-runtime-state'
import type { WriteSchedulingOperations } from '../profile-writing/write-scheduling'
import { scheduleSave } from '../profile-writing/write-scheduling'
import { revokeAgentSessionPublicationFences } from '../../../runtime/agent-session/agent-session-publication-fence'

type BotRuntime = Pick<StoreRuntimeState, 'state'>

/** The profile domains a bot write changes. */
const BOT_SAVE_DOMAINS = [
  'bots',
  'botsNewerAgents',
  'botOrder',
  'botsPermissionDefaultMigrated'
] as const

type CachedBots = {
  bots: readonly Bot[] | undefined
  botsNewerAgents: readonly Bot[] | undefined
  botOrder: readonly string[] | undefined
  botsLength: number
  newerLength: number
  orderLength: number
  ordered: Bot[]
}

function orderBots(all: Bot[], order: readonly string[]): Bot[] {
  if (all.length <= 1 || order.length === 0) {
    return all
  }
  const byId = new Map<string, Bot>()
  for (const bot of all) {
    byId.set(bot.id, bot)
  }
  if (byId.size === all.length) {
    const ordered: Bot[] = []
    for (const id of order) {
      const bot = byId.get(id)
      if (bot) {
        ordered.push(bot)
        byId.delete(id)
      }
    }
    for (const bot of byId.values()) {
      ordered.push(bot)
    }
    return ordered
  }
  const rankById = new Map<string, number>()
  for (let index = 0; index < order.length; index += 1) {
    const id = order[index]
    if (id !== undefined && !rankById.has(id)) {
      rankById.set(id, index)
    }
  }
  return all.sort(
    (a, b) => (rankById.get(a.id) ?? order.length) - (rankById.get(b.id) ?? order.length)
  )
}

const botPersistenceContext = Symbol('BotPersistence')
type BotPersistenceContext = {
  runtime: BotRuntime
  scheduling: WriteSchedulingOperations
  cached: CachedBots | null
}

export class BotPersistence {
  readonly [botPersistenceContext]: BotPersistenceContext

  constructor(runtime: BotRuntime, scheduling: WriteSchedulingOperations) {
    this[botPersistenceContext] = { runtime, scheduling, cached: null }
  }

  getBots(): Bot[] {
    const context = this[botPersistenceContext]
    const { state } = context.runtime
    const { bots, botsNewerAgents, botOrder } = state
    const botsLength = bots?.length ?? 0
    const newerLength = botsNewerAgents?.length ?? 0
    const orderLength = botOrder?.length ?? 0
    const { cached } = context
    if (
      cached &&
      cached.bots === bots &&
      cached.botsNewerAgents === botsNewerAgents &&
      cached.botOrder === botOrder &&
      cached.botsLength === botsLength &&
      cached.newerLength === newerLength &&
      cached.orderLength === orderLength
    ) {
      return cached.ordered
    }
    let ordered: Bot[]
    if (newerLength === 0 && !botOrder) {
      ordered = bots ?? []
    } else {
      const all = [...(bots ?? []), ...(botsNewerAgents ?? [])]
      ordered = botOrder ? orderBots(all, botOrder) : all
    }
    context.cached = {
      bots,
      botsNewerAgents,
      botOrder,
      botsLength,
      newerLength,
      orderLength,
      ordered
    }
    return ordered
  }

  private setBots(bots: Bot[]): void {
    const context = this[botPersistenceContext]
    const { state } = context.runtime
    const { readable, newer } = splitBotsByOlderBuildSupport(bots)
    state.bots = readable
    if (newer.length > 0) {
      const botOrder = bots.map((bot) => bot.id)
      state.botsNewerAgents = newer
      state.botOrder = botOrder
      context.cached = {
        bots: readable,
        botsNewerAgents: newer,
        botOrder,
        botsLength: readable.length,
        newerLength: newer.length,
        orderLength: botOrder.length,
        ordered: bots
      }
    } else {
      delete state.botsNewerAgents
      delete state.botOrder
      context.cached = {
        bots: readable,
        botsNewerAgents: undefined,
        botOrder: undefined,
        botsLength: readable.length,
        newerLength: 0,
        orderLength: 0,
        ordered: readable
      }
    }
  }

  /** Replaces by id in place, or appends: the cloud's older hello takes the first bots in this order. */
  saveBot(bot: Bot): void {
    revokeAgentSessionPublicationFences([JSON.stringify(['bot', bot.id])])
    const { runtime, scheduling } = this[botPersistenceContext]
    const bots = this.getBots()
    this.setBots(
      bots.some((entry) => entry.id === bot.id)
        ? bots.map((entry) => (entry.id === bot.id ? bot : entry))
        : [...bots, bot]
    )
    runtime.state.botsPermissionDefaultMigrated = true
    scheduleSave(scheduling, BOT_SAVE_DOMAINS)
  }

  removeBot(bot: Pick<Bot, 'id' | 'hostId'>): boolean {
    const { scheduling } = this[botPersistenceContext]
    const bots = this.getBots()
    const remaining = bots.filter((entry) => entry.id !== bot.id || entry.hostId !== bot.hostId)
    if (remaining.length === bots.length) {
      return false
    }
    revokeAgentSessionPublicationFences([JSON.stringify(['bot', bot.id])])
    this.setBots(remaining)
    scheduleSave(scheduling, BOT_SAVE_DOMAINS)
    return true
  }
}
