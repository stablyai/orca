import type { Bot } from '../../../../shared/bot-types'
import type { StoreRuntimeState } from '../store-runtime-state'
import type { WriteSchedulingOperations } from '../profile-writing/write-scheduling'
import { scheduleSave } from '../profile-writing/write-scheduling'
import { revokeAgentSessionPublicationFences } from '../../../runtime/agent-session/agent-session-publication-fence'

type BotRuntime = Pick<StoreRuntimeState, 'state'>

/** The profile domains a bot write changes. */
const BOT_SAVE_DOMAINS = ['bots', 'botsPermissionDefaultMigrated'] as const

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
    return this[botPersistenceContext].runtime.state.bots ?? []
  }

  /** Replaces by id in place, or appends: the cloud's older hello takes the first bots in this order. */
  saveBot(bot: Bot): void {
    revokeAgentSessionPublicationFences([JSON.stringify(['bot', bot.id])])
    const { runtime, scheduling } = this[botPersistenceContext]
    const bots = runtime.state.bots ?? []
    runtime.state.bots = bots.some((entry) => entry.id === bot.id)
      ? bots.map((entry) => (entry.id === bot.id ? bot : entry))
      : [...bots, bot]
    runtime.state.botsPermissionDefaultMigrated = true
    scheduleSave(scheduling, BOT_SAVE_DOMAINS)
  }

  removeBot(bot: Pick<Bot, 'id' | 'hostId'>): boolean {
    const { runtime, scheduling } = this[botPersistenceContext]
    const bots = runtime.state.bots ?? []
    const remaining = bots.filter((entry) => entry.id !== bot.id || entry.hostId !== bot.hostId)
    if (remaining.length === bots.length) {
      return false
    }
    revokeAgentSessionPublicationFences([JSON.stringify(['bot', bot.id])])
    runtime.state.bots = remaining
    scheduleSave(scheduling, BOT_SAVE_DOMAINS)
    return true
  }
}
