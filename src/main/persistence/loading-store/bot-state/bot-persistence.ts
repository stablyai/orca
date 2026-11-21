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

const botPersistenceContext = Symbol('BotPersistence')
type BotPersistenceContext = {
  runtime: BotRuntime
  scheduling: WriteSchedulingOperations
}

export class BotPersistence {
  readonly [botPersistenceContext]: BotPersistenceContext

  constructor(runtime: BotRuntime, scheduling: WriteSchedulingOperations) {
    this[botPersistenceContext] = { runtime, scheduling }
  }

  getBots(): Bot[] {
    const { state } = this[botPersistenceContext].runtime
    const all = [...(state.bots ?? []), ...(state.botsNewerAgents ?? [])]
    const order = state.botOrder
    if (!order) {
      return all
    }
    const rank = (id: string): number => {
      const index = order.indexOf(id)
      return index === -1 ? order.length : index
    }
    return all.sort((a, b) => rank(a.id) - rank(b.id))
  }

  private setBots(bots: Bot[]): void {
    const { state } = this[botPersistenceContext].runtime
    const { readable, newer } = splitBotsByOlderBuildSupport(bots)
    state.bots = readable
    if (newer.length > 0 || state.botsNewerAgents !== undefined) {
      state.botsNewerAgents = newer
      state.botOrder = bots.map((bot) => bot.id)
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
