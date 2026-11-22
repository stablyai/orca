import { splitBotsByOlderBuildSupport, type Bot } from '../../../../shared/bot-types'
import {
  isImmutableBotSnapshot,
  markImmutableBotSnapshot,
  orderBotsBySavedOrder
} from '../../../../shared/bots/bot-lookup-index'
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
  botsSnapshot: readonly Bot[]
  newerSnapshot: readonly Bot[]
  orderSnapshot: readonly string[]
  ordered: Bot[]
}

function snapshotOf<T>(items: readonly T[] | undefined): readonly T[] {
  if (!items) {
    return []
  }
  return isImmutableBotSnapshot(items) ? items : [...items]
}

function sameSnapshot<T>(
  source: readonly T[] | undefined,
  snapshot: readonly T[],
  expectedLength: number
): boolean {
  if (!source) {
    return expectedLength === 0
  }
  if (source.length !== expectedLength) {
    return false
  }
  if (isImmutableBotSnapshot(source)) {
    return true
  }
  return source.every((entry, index) => entry === snapshot[index])
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
    const { cached } = context
    if (
      cached &&
      cached.bots === bots &&
      cached.botsNewerAgents === botsNewerAgents &&
      cached.botOrder === botOrder &&
      sameSnapshot(bots, cached.botsSnapshot, cached.botsLength) &&
      sameSnapshot(botsNewerAgents, cached.newerSnapshot, cached.newerLength) &&
      sameSnapshot(botOrder, cached.orderSnapshot, cached.orderLength)
    ) {
      return cached.ordered
    }
    const botsLength = bots?.length ?? 0
    const newerLength = botsNewerAgents?.length ?? 0
    const orderLength = botOrder?.length ?? 0
    let ordered: Bot[]
    if (newerLength === 0 && !botOrder) {
      ordered = bots ? (isImmutableBotSnapshot(bots) ? bots : [...bots]) : []
    } else {
      const all = [...(bots ?? []), ...(botsNewerAgents ?? [])]
      ordered = botOrder ? orderBotsBySavedOrder(all, botOrder) : all
    }
    markImmutableBotSnapshot(ordered)
    context.cached = {
      bots,
      botsNewerAgents,
      botOrder,
      botsLength,
      newerLength,
      orderLength,
      botsSnapshot: snapshotOf(bots),
      newerSnapshot: snapshotOf(botsNewerAgents),
      orderSnapshot: snapshotOf(botOrder),
      ordered
    }
    return ordered
  }

  private setBots(bots: Bot[]): void {
    const context = this[botPersistenceContext]
    const { state } = context.runtime
    const { readable, newer } = splitBotsByOlderBuildSupport(bots)
    markImmutableBotSnapshot(readable)
    state.bots = readable
    if (newer.length > 0) {
      const botOrder = markImmutableBotSnapshot(bots.map((bot) => bot.id))
      const ordered = markImmutableBotSnapshot([...bots])
      markImmutableBotSnapshot(newer)
      state.botsNewerAgents = newer
      state.botOrder = botOrder
      context.cached = {
        bots: readable,
        botsNewerAgents: newer,
        botOrder,
        botsLength: readable.length,
        newerLength: newer.length,
        orderLength: botOrder.length,
        botsSnapshot: readable,
        newerSnapshot: newer,
        orderSnapshot: botOrder,
        ordered
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
        botsSnapshot: readable,
        newerSnapshot: [],
        orderSnapshot: [],
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
